"""The ADK agent + AG-UI bridge."""

from __future__ import annotations

from ag_ui_adk import ADKAgent
from google.adk.agents import LlmAgent
from google.adk.tools import FunctionTool

from .model import build_model
from .tools import create_action_plan, score_github_issues

INSTRUCTION = (
    "You are a GitHub issue scorer for product teams. When the user names a "
    "repository, call the score_github_issues tool with the parsed owner and "
    "repo (and issue_number or limit if given). Accept these forms: "
    "'owner/repo' (top 5 open issues), 'owner/repo 20' (top 20, max 50), and "
    "'owner/repo#123' (a single issue). The dashboard sends the count "
    "explicitly, as in 'Score the top 20 open issues in owner/repo' — when a "
    "count is stated, pass exactly that number as `limit`; never substitute a "
    "different number or fall back to the default. While the tool runs it streams scored "
    "issues into the dashboard, so keep your narration brief: say which repo "
    "you're scoring, then give a short summary of the highest-priority issues "
    "once it finishes. Never invent issue data — rely on the tool's results.\n\n"
    "When the user asks for a plan, next steps, or how to tackle the issues, "
    "call create_action_plan. It hands the scored issues to a specialist "
    "planner agent over A2A and streams a remediation plan into the dashboard. "
    "After it returns, briefly point the user to the plan panel; don't repeat "
    "the whole plan."
)

root_agent = LlmAgent(
    name="github_issue_scorer",
    model=build_model(),
    description="Scores open GitHub issues by sentiment, priority, competitor "
    "mentions, and workarounds.",
    instruction=INSTRUCTION,
    tools=[FunctionTool(score_github_issues), FunctionTool(create_action_plan)],
)

# AG-UI middleware. Single-user demo: static user id + in-memory session
# services (session state resets on restart, which is fine for a demo).
adk_middleware = ADKAgent(
    root_agent,
    app_name="github_issue_scorer",
    user_id="dashboard-user",
    use_in_memory_services=True,
)
