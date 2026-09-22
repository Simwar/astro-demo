"""GitHub REST access + per-issue LLM scoring.

Ports the reference github-issue-scorer's logic: fetch open issues (excluding
PRs), pull comments, ask the model for a strict-JSON analysis (sentiment,
priority, competitor mentions, workarounds), and normalise defensively.

GitHub access uses async httpx (GITHUB_TOKEN, injected by the platform).

Scoring is split across two models, both reached through the Postman Fabric
Gateway. Jev answers the typed questions (see jev.py) and cannot return an
out-of-enum value; the LLM writes the prose. They run concurrently, so the
wall-clock cost is the slower of the two rather than the sum, and Jev's answers
override the LLM's where it answered.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Optional

import httpx
import litellm

from . import gateway
from . import jev
from . import telemetry as tel

log = logging.getLogger("scorer")

# --- Constants (mirror the reference agent) ---------------------------------
MAX_ISSUES = 50
BODY_TRUNC = 2000
COMMENT_TRUNC = 500
PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}
VALID_SENTIMENTS = {"frustration", "urgency", "neutral", "positive"}
VALID_PRIORITIES = {"high", "medium", "low"}

GITHUB_API = "https://api.github.com"

ANALYSIS_SYSTEM_PROMPT = (
    "You are a senior product manager triaging GitHub issues. For the single "
    "issue provided (title, body, and comments), return ONLY a JSON object with "
    "exactly these fields:\n"
    '  "summary": one-sentence plain-language summary of the issue.\n'
    '  "sentiment": one of "frustration", "urgency", "neutral", "positive".\n'
    '  "sentiment_details": one short sentence justifying the sentiment.\n'
    '  "competitive_mentions": array of competitor product names mentioned '
    "(empty array if none).\n"
    '  "workarounds": array of short strings describing any workarounds users '
    "mention (empty array if none).\n"
    '  "priority": one of "high", "medium", "low" — how urgently the product '
    "team should act. Use HIGH for security vulnerabilities/CVEs, crashes, data "
    "loss/corruption, or issues blocking many users; MEDIUM for meaningful bugs "
    "or common friction with a workaround; LOW only for minor, cosmetic, or "
    "edge-case issues. Distinguish across issues — do not rate everything low.\n"
    '  "priority_reason": one short sentence explaining the priority.\n'
    "Base every field only on the issue content. Do not invent facts. Use "
    "lowercase for the sentiment and priority values. Respond with the JSON "
    "object and nothing else — no markdown, no code fences."
)


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _reactions(issue: dict[str, Any]) -> dict[str, int]:
    r = issue.get("reactions") or {}
    return {
        "upvotes": int(r.get("+1", 0)),
        "total_reactions": int(r.get("total_count", 0)),
        "comments": int(issue.get("comments", 0)),
    }


async def fetch_open_issues(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    issue_number: Optional[int],
    limit: int,
) -> list[dict[str, Any]]:
    """Return raw issue payloads (PRs excluded). Single issue if issue_number set."""
    if issue_number is not None:
        resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}/issues/{issue_number}",
            headers=_headers(),
        )
        resp.raise_for_status()
        return [resp.json()]

    cap = max(1, min(limit, MAX_ISSUES))
    out: list[dict[str, Any]] = []
    page = 1
    while len(out) < cap:
        resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}/issues",
            headers=_headers(),
            params={"state": "open", "per_page": 100, "page": page},
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        # Exclude pull requests (they surface on the issues endpoint too).
        out.extend(i for i in batch if "pull_request" not in i)
        page += 1
    return out[:cap]


async def fetch_comments(
    client: httpx.AsyncClient, owner: str, repo: str, number: int
) -> list[str]:
    resp = await client.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/issues/{number}/comments",
        headers=_headers(),
        params={"per_page": 100},
    )
    if resp.status_code != 200:
        return []
    return [c.get("body", "") for c in resp.json()]


def _extract_json(content: str) -> dict[str, Any]:
    """Parse the model's JSON tolerantly.

    Models routed through the gateway don't always honour response_format: they
    may wrap the object in ```json fences or add prose around it. Try a straight
    parse, then a fenced block, then the first balanced {...} span.
    """
    if not content:
        return {}
    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    span = re.search(r"\{.*\}", content, re.DOTALL)
    if span:
        try:
            return json.loads(span.group(0))
        except json.JSONDecodeError:
            pass
    log.warning("scoring: could not parse JSON from model output: %r", content[:300])
    return {}


def _coerce_enum(value: Any, valid: set[str], default: str, field: str) -> str:
    """Match enum values case-insensitively (the model often returns 'High',
    'Frustration', etc.). Log when we fall back so misses are visible in logs."""
    if isinstance(value, str):
        token = value.strip().lower()
        if token in valid:
            return token
        # e.g. "high priority" / "urgent" -> pick the valid token it contains.
        for v in valid:
            if v in token:
                return v
    log.warning("scoring: %s=%r not in %s; defaulting to %s", field, value, valid, default)
    return default


def normalize_analysis(raw: Any) -> dict[str, Any]:
    """Defensive defaults so a malformed model response never breaks a card."""
    # Lower-case top-level keys: models often return "Priority"/"Sentiment"
    # (capitalised) even when the schema uses lowercase, which would otherwise
    # miss every case-sensitive .get() and default the whole card.
    data = (
        {k.lower(): v for k, v in raw.items() if isinstance(k, str)}
        if isinstance(raw, dict)
        else {}
    )
    return {
        "summary": data.get("summary") or "(no summary)",
        "sentiment": _coerce_enum(
            data.get("sentiment"), VALID_SENTIMENTS, "neutral", "sentiment"
        ),
        "sentiment_details": data.get("sentiment_details") or "",
        "competitive_mentions": data.get("competitive_mentions")
        if isinstance(data.get("competitive_mentions"), list)
        else [],
        "workarounds": data.get("workarounds")
        if isinstance(data.get("workarounds"), list)
        else [],
        "priority": _coerce_enum(
            data.get("priority"), VALID_PRIORITIES, "low", "priority"
        ),
        "priority_reason": data.get("priority_reason") or "",
    }


async def _score_prose(issue: dict[str, Any], comments: list[str]) -> dict[str, Any]:
    """Ask the LLM for a strict-JSON analysis of one issue.

    Still asks for `priority` and `sentiment` as well as the prose fields. Those
    cost a handful of tokens and are what the card falls back to whenever Jev
    does not answer — which is why the defensive normalisation below stays.
    """
    body = (issue.get("body") or "")[:BODY_TRUNC]
    joined_comments = "\n".join(f"- {c[:COMMENT_TRUNC]}" for c in comments)
    user_msg = (
        f"Title: {issue.get('title', '')}\n\n"
        f"Body:\n{body}\n\n"
        f"Comments:\n{joined_comments or '(none)'}"
    )

    # Trace each scoring call as a generation so token usage/cost land in the
    # platform's run view. These are direct LiteLLM calls (outside ADK), so they
    # wouldn't be captured otherwise.
    with tel.get_tracer().start_as_current_span(f"prose-#{issue.get('number')}") as span:
        span.set_attribute(tel.OBS_TYPE, "generation")
        span.set_attribute(tel.GEN_MODEL, gateway.PROSE_MODEL)
        span.set_attribute(tel.OBS_INPUT, user_msg[:4000])

        # Now that the prose model is an actual OpenAI model behind the gateway's
        # /openai route, JSON mode works properly — the previous path went to
        # Claude through a LiteLLM proxy, where the emulation returned an empty
        # "{}" for every call. _extract_json below is kept anyway: it is no longer
        # propping up the happy path, it is the last guard on the Jev-unavailable
        # fallback, where a bad parse would cost a real priority.
        resp = await litellm.acompletion(
            model=f"openai/{gateway.PROSE_MODEL}",
            api_base=gateway.openai_base_url(),
            api_key=gateway.BROKERED_BY_GATEWAY,
            extra_headers=gateway.openai_headers(),
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=700,
        )
        content = resp["choices"][0]["message"]["content"]
        span.set_attribute(tel.OBS_OUTPUT, (content or "")[:4000])
        usage = getattr(resp, "usage", None)
        if usage is not None:
            span.set_attribute(tel.GEN_IN_TOKENS, getattr(usage, "prompt_tokens", 0) or 0)
            span.set_attribute(tel.GEN_OUT_TOKENS, getattr(usage, "completion_tokens", 0) or 0)

    parsed = _extract_json(content)
    # If the expected fields still aren't present (nesting, renamed keys, etc.),
    # surface the raw output so the actual shape is visible in the logs.
    if not (isinstance(parsed, dict) and {k.lower() for k in parsed} & {"priority", "sentiment"}):
        log.warning("scoring: model output missing expected fields: %r", content[:400])
    return normalize_analysis(parsed)


def merge_analysis(
    prose: dict[str, Any], jev_scores: dict[str, Any] | None
) -> dict[str, Any]:
    """Jev's typed answers win over the LLM's for the fields it covers.

    When Jev did not run — disabled, errored, or unusable — the LLM's own enums
    are used unchanged. jev_scores only ever contains keys Jev is authoritative
    for, so a plain overlay is the whole merge.
    """
    if not jev_scores:
        return prose
    return {**prose, **jev_scores}


async def score_issue(issue: dict[str, Any], comments: list[str]) -> dict[str, Any]:
    """Score one issue with both models concurrently (async -> its own event
    boundary, which keeps STATE_DELTAs streaming one card at a time).

    Wrapped in a per-issue span so a 20-issue run reads as 20 groups of two
    generations, rather than 40 sibling spans under the tool call. Context
    propagates into both tasks because asyncio copies contextvars on task
    creation, so the two generations nest underneath this span.
    """
    number = issue.get("number")
    with tel.get_tracer().start_as_current_span(f"issue-#{number}") as span:
        span.set_attribute(tel.OBS_TYPE, "span")
        span.set_attribute("issue.number", number or 0)
        span.set_attribute("issue.title", (issue.get("title") or "")[:200])
        span.set_attribute("issue.comments", len(comments))

        prose, jev_scores = await asyncio.gather(
            _score_prose(issue, comments),
            jev.score_issue(issue, comments),
        )
        merged = merge_analysis(prose, jev_scores)

        # The one attribute worth scanning a trace for: which model actually
        # decided this card's priority.
        span.set_attribute(
            "issue.scored_by", "jev" if jev_scores else "llm-fallback"
        )
        span.set_attribute("issue.priority", merged["priority"])
        span.set_attribute("issue.sentiment", merged["sentiment"])
        if merged.get("severity") is not None:
            span.set_attribute("issue.severity", merged["severity"])
        if merged.get("priority_confidence") is not None:
            span.set_attribute(
                "issue.priority_confidence", merged["priority_confidence"]
            )
        span.set_attribute(
            tel.OBS_OUTPUT,
            f"{merged['priority']}/{merged['sentiment']}"
            + (
                f" severity={merged['severity']:.2f}"
                if merged.get("severity") is not None
                else ""
            ),
        )
        return merged
