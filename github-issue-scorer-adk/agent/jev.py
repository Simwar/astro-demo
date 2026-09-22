"""Jev scoring: the typed half of the analysis.

Jev (TypeSafe's System One model) returns typed decisions with calibrated
probabilities and generates no text at all, so it covers the enum half of the
analysis only — priority, sentiment, severity, plus two yes/no cross-checks. The
prose half (summary, justifications, extracted lists) stays on the LLM.

All five questions go in a single batched call: the issue text is billed once
instead of five times, which is the whole reason not to split them up.

Jev never breaks a run. Any failure returns None and the caller keeps the LLM's
own enums, which is why the prose prompt still asks for them.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score

from . import gateway
from . import telemetry as tel

log = logging.getLogger("scorer")

VALID_PRIORITIES = {"high", "medium", "low"}
VALID_SENTIMENTS = {"frustration", "urgency", "neutral", "positive"}

BODY_TRUNC = 2000
COMMENT_TRUNC = 500
# fetch_comments already requests a single page (100 max), so this is belt and
# braces — but it makes Jev's 32k `state` budget explicit at the point of use,
# and holds if comment fetching ever starts paginating.
MAX_ANALYSED_COMMENTS = 120

QUESTIONS = {
    "priority": Choice(
        instructions="How urgent is this issue for the maintainers?",
        criteria={
            "high": {"what": "Security vulnerability, data loss, crash, or blocker"},
            "medium": {
                "what": "Significant bug, degraded UX, or important feature request"
            },
            "low": {"what": "Minor bug, cosmetic issue, nice-to-have, or question"},
        },
    ),
    "sentiment": Choice(
        instructions="What is the tone of the reporter and the commenters?",
        criteria={
            "frustration": {"what": "Annoyed, exasperated, or repeatedly blocked"},
            "urgency": {"what": "Under time pressure; needs resolving soon"},
            "neutral": {"what": "Matter-of-fact report with no strong feeling"},
            "positive": {"what": "Appreciative, constructive, or complimentary"},
        },
    ),
    "severity": Score(
        instructions="How severe is the user impact?",
        criteria=[
            "Cosmetic; no impact to functionality",
            "Broken or degraded feature, but a workaround exists",
            "Blocking issue; no workaround",
        ],
    ),
    "has_workaround": Noul(
        instructions="A commenter describes a working workaround"
    ),
    "mentions_competitor": Noul(
        instructions="A commenter compares this to a competing tool"
    ),
}

_client: Optional[AsyncTypeSafeClient] = None


def client() -> AsyncTypeSafeClient:
    """Lazily built and reused: one HTTP pool for the process, not one per issue."""
    global _client
    if _client is None:
        # The /jev route authenticates on Authorization: Bearer, which is what
        # the SDK sends from api_key — so the gateway key goes there. Passing
        # X-Gateway-Key instead returns a bare 401. See gateway.py.
        _client = AsyncTypeSafeClient(
            api_key=gateway.jev_api_key(),
            base_url=gateway.jev_base_url(),
        )
    return _client


def reset_client() -> None:
    """Test-only: drop the memoised client so env changes take effect."""
    global _client
    _client = None


def build_state(issue: dict[str, Any], comments: list[str]) -> dict[str, Any]:
    """The issue as structured state, under the same caps the prose call uses so
    both models see the same input."""
    return {
        "title": issue.get("title", ""),
        "body": (issue.get("body") or "")[:BODY_TRUNC] or "(no description)",
        "comments": [c[:COMMENT_TRUNC] for c in comments[:MAX_ANALYSED_COMMENTS]],
    }


# --- Answer normalisation --------------------------------------------------
# The SDK models the answers, but the response is still whatever came back over
# the wire — a gateway error page, a partial payload, a future schema change.


def _field(obj: Any, name: str) -> Any:
    """Read a field off either a model instance or a plain dict."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _buckets(result: Any) -> tuple[dict, dict, dict]:
    """Group the answers by primitive, accepting either response shape.

    The documented Python SDK splits answers into `.choices` / `.scores` /
    `.nouls`; the wire format (and the JavaScript SDK) use a single flat
    `answers` map keyed by question name. Accept both, so that if the SDK's
    shape differs from the docs we degrade to the LLM fallback loudly via the
    warning in score_issue rather than silently never using Jev at all.
    """
    choices = dict(_field(result, "choices") or {})
    scores = dict(_field(result, "scores") or {})
    nouls = dict(_field(result, "nouls") or {})
    if choices or scores or nouls:
        return choices, scores, nouls

    for name, answer in (_field(result, "answers") or {}).items():
        kind = _field(answer, "type")
        if kind == "choice":
            choices[name] = answer
        elif kind == "score":
            scores[name] = answer
        elif kind == "noul":
            nouls[name] = answer
    return choices, scores, nouls


def _read_choice(answer: Any, valid: set[str]) -> Optional[tuple[str, float]]:
    value = _field(answer, "choice")
    if not isinstance(value, str) or value not in valid:
        return None
    confidence = _field(answer, "confidence")
    return value, float(confidence) if isinstance(confidence, (int, float)) else 0.0


def _read_score(answer: Any) -> Optional[float]:
    value = _field(answer, "score")
    return float(value) if isinstance(value, (int, float)) else None


def _read_noul(answer: Any) -> Optional[bool]:
    value = _field(answer, "noul")
    return bool(value > 0.5) if isinstance(value, (int, float)) else None


def normalize_scores(result: Any) -> Optional[dict[str, Any]]:
    """Map a SystemOneResponse onto card fields, or None if it is unusable.

    Reads whichever response shape the SDK hands back; see _buckets.
    """
    choices, scores, nouls = _buckets(result)

    priority = _read_choice(choices.get("priority"), VALID_PRIORITIES)
    sentiment = _read_choice(choices.get("sentiment"), VALID_SENTIMENTS)
    # These two are the entire point of the call. Without both, fall back to the
    # LLM's own enums rather than merging half an answer.
    if priority is None or sentiment is None:
        return None

    out: dict[str, Any] = {
        "priority": priority[0],
        "priority_confidence": priority[1],
        "sentiment": sentiment[0],
        "sentiment_confidence": sentiment[1],
    }
    severity = _read_score(scores.get("severity"))
    if severity is not None:
        out["severity"] = severity
    workaround = _read_noul(nouls.get("has_workaround"))
    if workaround is not None:
        out["workaround_signal"] = workaround
    competitor = _read_noul(nouls.get("mentions_competitor"))
    if competitor is not None:
        out["competitor_signal"] = competitor
    return out


async def score_issue(
    issue: dict[str, Any], comments: list[str]
) -> Optional[dict[str, Any]]:
    """Score one issue with Jev. Never raises: returns None on any failure."""
    if not gateway.jev_enabled():
        return None

    number = issue.get("number")
    state = build_state(issue, comments)
    try:
        with tel.get_tracer().start_as_current_span(f"jev-score-#{number}") as span:
            span.set_attribute(tel.OBS_TYPE, "generation")
            span.set_attribute(tel.GEN_MODEL, gateway.JEV_MODEL)
            span.set_attribute(tel.OBS_INPUT, str(state)[:4000])
            result = await client().system_one(
                state, QUESTIONS, model=gateway.JEV_MODEL
            )
            scores = normalize_scores(result)
            span.set_attribute(tel.OBS_OUTPUT, str(scores)[:4000])
            usage = getattr(result, "usage", None)
            if usage is not None:
                span.set_attribute(
                    tel.GEN_IN_TOKENS, getattr(usage, "input_tokens", 0) or 0
                )
                span.set_attribute(
                    tel.GEN_OUT_TOKENS, getattr(usage, "output_tokens", 0) or 0
                )
        if scores is None:
            log.warning("jev: unusable answers for #%s; using LLM enums", number)
        return scores
    except Exception as exc:  # noqa: BLE001 — Jev must never break a run
        log.warning("jev: scoring #%s failed (%s); using LLM enums", number, exc)
        return None
