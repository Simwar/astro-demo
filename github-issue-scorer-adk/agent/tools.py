"""The score_github_issues tool.

The live dashboard is driven by ADK session state -> AG-UI STATE_DELTA:
ag_ui_adk emits a STATE_DELTA (JSON Patch) whenever the tool mutates
`tool_context.state`. Two rules the bridge imposes:

  1. It only emits `op: "add"` patches, which overwrite at an object path — so
     state.issues is a KEYED MAP (by issue number), never a list mutated by
     index. Each update re-puts the whole card object under its key.
  2. No `temp:`-prefixed keys (ADK strips those from the emitted delta).

The tool is async and awaits per issue, so each scoring step is its own ADK
event boundary and the frontend fills cards in one at a time.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx
from google.adk.tools import ToolContext

from . import a2a_client
from . import gateway
from . import github
from . import telemetry as tel

log = logging.getLogger("scorer")

# The action-planner agent's public URL (its Launch URL), injected as an input.
PLANNER_A2A_URL = os.environ.get("PLANNER_A2A_URL")


def _session_user(tool_context: ToolContext | None) -> tuple[str | None, str | None]:
    """Best-effort pull of the ADK session id + user id for trace attribution.
    Reads ADK internals defensively — never fatal if the shape changes."""
    if tool_context is None:
        return None, None
    ctx = getattr(tool_context, "_invocation_context", None)
    sess = getattr(ctx, "session", None)
    sid = getattr(sess, "id", None) if sess is not None else None
    uid = getattr(sess, "user_id", None) if sess is not None else None
    return sid, uid or getattr(ctx, "user_id", None)

# The deployed ingress (Contour/Envoy behind an ALB) caps how long a single
# streamed response may run. Scoring issues sequentially (N x LLM latency) blows
# past it, so we score concurrently — bounded to keep gateway load sane.
SCORE_CONCURRENCY = 6


def _skeleton(issue: dict[str, Any]) -> dict[str, Any]:
    return {
        "number": issue["number"],
        "title": issue.get("title", ""),
        "url": issue.get("html_url", ""),
        "status": "pending",
        **github._reactions(issue),
    }


async def score_github_issues(
    owner: str,
    repo: str,
    issue_number: Optional[int] = None,
    limit: int = 5,
    tool_context: ToolContext = None,
) -> dict[str, Any]:
    """Fetch open GitHub issues and score each for sentiment and priority.

    Streams results into the dashboard as each issue is scored.

    Args:
        owner: GitHub repository owner or organisation.
        repo: Repository name.
        issue_number: If set, score only this single issue.
        limit: Max number of issues to score (default 5, max 50).

    Returns:
        A summary of how many issues were scored and their priority ranking.
    """
    # Wrap the run in a span so it (and the per-issue generation spans nested
    # under it) show up as one trace with input/output/session/user in Astro.
    target = (
        f"{owner}/{repo}#{issue_number}"
        if issue_number is not None
        else f"{owner}/{repo} (top {max(1, min(limit, github.MAX_ISSUES))})"
    )
    with tel.get_tracer().start_as_current_span("score_github_issues") as span:
        span.set_attribute(tel.OBS_TYPE, "span")
        span.set_attribute(tel.OBS_INPUT, target)
        span.set_attribute(tel.TRACE_INPUT, target)
        span.set_attribute("scorer.repo", f"{owner}/{repo}")
        span.set_attribute("scorer.prose_model", gateway.PROSE_MODEL)
        span.set_attribute("scorer.jev_model", gateway.JEV_MODEL)
        span.set_attribute("scorer.jev_enabled", gateway.jev_enabled())
        span.set_attribute("scorer.concurrency", SCORE_CONCURRENCY)
        sid, uid = _session_user(tool_context)
        if sid:
            span.set_attribute(tel.SESSION_ID, sid)
        if uid:
            span.set_attribute(tel.USER_ID, uid)

        result = await _run_scoring(owner, repo, issue_number, limit, tool_context)

        summary = result.get("message") or ", ".join(
            f"#{r['number']}:{r['priority']}" for r in result.get("ranking", [])
        )
        span.set_attribute("scorer.issues_scored", result.get("scored", 0))
        span.set_attribute(tel.OBS_OUTPUT, summary)
        span.set_attribute(tel.TRACE_OUTPUT, summary)
        return result


async def _run_scoring(
    owner: str,
    repo: str,
    issue_number: Optional[int],
    limit: int,
    tool_context: ToolContext | None,
) -> dict[str, Any]:
    """Core scoring logic (traced by the public wrapper above)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        issues = await github.fetch_open_issues(
            client, owner, repo, issue_number, limit
        )

        if not issues:
            if tool_context is not None:
                tool_context.state["issues"] = {}
                tool_context.state["run"] = {
                    "total": 0,
                    "done": 0,
                    "repo": f"{owner}/{repo}",
                    "status": "done",
                }
            return {"scored": 0, "message": f"No open issues found in {owner}/{repo}."}

        # 1) Announce the run: skeleton cards (status=pending) so the UI can
        #    render placeholders immediately via STATE_SNAPSHOT/DELTA.
        cards: dict[str, dict[str, Any]] = {
            str(i["number"]): _skeleton(i) for i in issues
        }
        if tool_context is not None:
            tool_context.state["issues"] = cards
            tool_context.state["run"] = {
                "total": len(issues),
                "done": 0,
                "repo": f"{owner}/{repo}",
                "status": "scoring",
            }

        # 2) Score concurrently (bounded by SCORE_CONCURRENCY). Collapsing N
        #    sequential LLM calls into parallel work keeps the whole run within
        #    the ingress's streaming-response window. State is still updated as
        #    each issue finishes (via as_completed), so cards fill in live.
        sem = asyncio.Semaphore(SCORE_CONCURRENCY)

        async def _score(issue: dict[str, Any]) -> tuple[str, dict[str, Any]]:
            number = str(issue["number"])
            try:
                async with sem:
                    comments = await github.fetch_comments(
                        client, owner, repo, issue["number"]
                    )
                    analysis = await github.score_issue(issue, comments)
                return number, {**cards[number], **analysis, "status": "scored"}
            except Exception as exc:  # one bad issue shouldn't sink the batch
                log.warning("scoring: issue #%s failed: %s", number, exc)
                return number, {**cards[number], "status": "scored"}

        done = 0
        tasks = [asyncio.create_task(_score(i)) for i in issues]
        for fut in asyncio.as_completed(tasks):
            number, card = await fut
            cards[number] = card
            done += 1
            if tool_context is not None:
                # New dict identity so ADK captures the change into state_delta.
                tool_context.state["issues"] = {**cards}
                tool_context.state["run"] = {
                    "total": len(issues),
                    "done": done,
                    "repo": f"{owner}/{repo}",
                    "status": "scoring" if done < len(issues) else "done",
                }

    ranked = sorted(
        cards.values(),
        key=lambda c: github.PRIORITY_ORDER.get(c.get("priority", "low"), 2),
    )
    return {
        "scored": len(ranked),
        "repo": f"{owner}/{repo}",
        "ranking": [
            {"number": c["number"], "priority": c.get("priority"), "title": c["title"]}
            for c in ranked
        ],
    }


def _issues_for_plan(state: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Compact text digest of the scored issues to hand the planner over A2A."""
    scored = [c for c in (state.get("issues") or {}).values() if c.get("status") == "scored"]
    scored.sort(key=lambda c: github.PRIORITY_ORDER.get(c.get("priority", "low"), 2))
    lines = []
    for c in scored:
        lines.append(
            f"#{c['number']} [{c.get('priority', '?')}/{c.get('sentiment', '?')}] "
            f"{c.get('title', '')}\n"
            f"    summary: {c.get('summary', '')}\n"
            f"    reasoning: {c.get('priority_reason', '')}"
            + (
                f"\n    competitors: {', '.join(c['competitive_mentions'])}"
                if c.get("competitive_mentions")
                else ""
            )
        )
    return "\n".join(lines), scored


async def create_action_plan(tool_context: ToolContext = None) -> dict[str, Any]:
    """Send the scored issues to the action-planner agent (over A2A) and get back
    a clustered, sequenced remediation plan. Call this after scoring, when the
    user wants a plan / next steps / how to tackle the issues.

    Returns:
        A status object; the full plan is streamed into the dashboard.
    """
    if not PLANNER_A2A_URL:
        return {"error": "The action planner isn't configured (PLANNER_A2A_URL is unset)."}

    state = tool_context.state if tool_context is not None else {}
    digest, scored = _issues_for_plan(state)
    if not scored:
        return {"error": "No scored issues yet — score a repository first, then ask for a plan."}

    repo = (state.get("run") or {}).get("repo", "the repository")
    if tool_context is not None:
        tool_context.state["plan"] = {"status": "planning", "markdown": ""}

    prompt = (
        f"These open issues in {repo} have been scored. Produce a remediation "
        f"plan:\n\n{digest}"
    )

    with tel.get_tracer().start_as_current_span("create_action_plan") as span:
        span.set_attribute(tel.OBS_TYPE, "span")
        span.set_attribute(tel.OBS_INPUT, prompt[:4000])
        try:
            plan = await a2a_client.request_plan(PLANNER_A2A_URL, prompt)
        except Exception as exc:
            log.warning("planner A2A call failed: %s", exc)
            if tool_context is not None:
                tool_context.state["plan"] = {"status": "error", "markdown": str(exc)}
            span.set_attribute(tel.OBS_OUTPUT, f"error: {exc}")
            return {"error": f"Couldn't reach the action planner: {exc}"}
        span.set_attribute(tel.OBS_OUTPUT, plan[:4000])

    if tool_context is not None:
        tool_context.state["plan"] = {"status": "ready", "markdown": plan}
    return {"ok": True, "planned_issues": len(scored), "repo": repo}
