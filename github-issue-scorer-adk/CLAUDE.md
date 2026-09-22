# github-issue-scorer-adk

Python ADK + AG-UI agent that scores open GitHub issues (sentiment + priority)
and streams results to a React dashboard. FastAPI on :80 serves `/agui` (AG-UI
SSE) and `/` (static frontend).

Key files: `agent/main.py` (server), `agent/agent.py` (ADK + ag_ui_adk),
`agent/tools.py` (session-state → live UI), `agent/github.py` (REST + hybrid
scoring), `agent/jev.py` (typed scoring), `agent/gateway.py` (Fabric Gateway
config), `agent/model.py` (LiteLlm → gateway). Frontend in `frontend/`.

All model traffic goes through the Postman Fabric Gateway — `gpt-4o-mini` on
`/openai/v1` via LiteLLM for prose and the chat loop, `jev-latest` on `/jev` via
`typesafe-sdk` for priority/sentiment/severity. One credential,
`FABRIC_GATEWAY_KEY`, sent as `X-Gateway-Key`; no provider keys in the container
and no direct-to-provider fallback. Jev failures degrade to the LLM's own enums,
which is why the prose prompt still asks for them. Run `ast docs` for platform
documentation.
