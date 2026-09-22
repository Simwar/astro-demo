# github-issue-scorer-adk

Python ADK + AG-UI agent that scores open GitHub issues (sentiment + priority)
and streams results to a React dashboard. FastAPI on :80 serves `/agui` (AG-UI
SSE) and `/` (static frontend).

Key files: `agent/main.py` (server), `agent/agent.py` (ADK + ag_ui_adk),
`agent/tools.py` (session-state → live UI), `agent/github.py` (REST + scoring),
`agent/model.py` (LiteLlm → Astro gateway). Frontend in `frontend/`.

Model + scoring both go through the Astro AI gateway (OpenAI-compatible) via
LiteLLM. Run `ast docs` for platform documentation.
