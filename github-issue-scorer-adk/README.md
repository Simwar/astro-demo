# github-issue-scorer-adk

An [Astropods](https://astropods.com) agent that scores a repository's open
GitHub issues for **sentiment** and **priority** and streams the results into a
live web dashboard. Built on **Google ADK** and the **AG-UI protocol** (a Python
recreation of the Mastra/TS `github-issue-scorer`).

Scoring is split across two models, both reached through the **Postman Fabric
Gateway**: **Jev** answers the typed questions — priority, sentiment, severity —
and returns a calibrated confidence with each, while the LLM writes the prose.
Jev generates no text, so it cannot return a value outside the enum. The two run
concurrently, and the gateway holds the upstream credentials so this agent
carries none of its own.

## Stack

| Layer | Choice |
| --- | --- |
| Agent framework | Google ADK (`google-adk`), Python |
| UI protocol | AG-UI via `ag_ui_adk` (FastAPI SSE at `/agui`) |
| Typed scoring | `jev-latest` via Fabric Gateway `/jev`, through `typesafe-sdk` |
| Prose + chat | `gpt-4o-mini` via Fabric Gateway `/openai/v1`, through LiteLLM |
| Frontend | React + Vite using `@ag-ui/client`, served as static files by FastAPI |
| GitHub | REST API via `httpx` with the injected `GITHUB_TOKEN` |

One container, one FastAPI process on port 80: `/agui` (AG-UI) + `/` (dashboard).

## Layout

```
agent/
  main.py     FastAPI app: /agui endpoint + static SPA mount + uvicorn
  agent.py    ADK LlmAgent + ag_ui_adk ADKAgent bridge
  gateway.py  Fabric Gateway config: per-route base URLs + auth, fail-closed check
  jev.py      Jev question set, state budget, answer normalisation
  model.py    LiteLlm pointed at the Fabric Gateway's /openai route
  tools.py    score_github_issues — writes results into session state (live UI)
  github.py   GitHub REST client + hybrid per-issue scoring + normalization
frontend/     React/Vite dashboard (built to ../static in the Docker image)
```

## Local development

The platform injects `GITHUB_TOKEN` and `PORT`; `ast configure` supplies
`FABRIC_GATEWAY_KEY`. The agent refuses to start without the gateway key rather
than failing on the first message. The simplest path is the Astro stack:

```bash
ast spec validate
ast project start        # builds + runs the container; prints the frontend URL
ast project logs
```

Or run the two processes directly (needs the env vars set):

```bash
pip install -r requirements.txt
python -m agent.main                 # backend on :8808

cd frontend && npm install && npm run dev   # Vite on :5173, proxies /agui -> :8808
```

Then enter a repo (`owner/repo`, `owner/repo 20`, or `owner/repo#123`) and watch
the cards fill in.

## How the live dashboard works

`score_github_issues` writes a keyed map of issue cards into ADK session state and
re-puts each card as it's scored. `ag_ui_adk` turns those state mutations into
AG-UI `STATE_DELTA` events; `@ag-ui/client` merges them and the React app
re-renders. The tool is async and awaits per issue, so cards stream in one at a
time rather than all at once.

## Models and credentials

| Variable | Description |
| --- | --- |
| `FABRIC_GATEWAY_KEY` | Gateway key for both routes (see auth note below). Required at startup |
| `FABRIC_GATEWAY_URL` | Gateway base URL; defaults to the team gateway |
| `JEV_ENABLED` | Set to `0` to score with the LLM alone, for comparison |
| `PROSE_MODEL` / `JEV_MODEL` | Model id overrides (`gpt-4o-mini`, `jev-latest`) |
| `PLANNER_A2A_URL` | Optional: action-planner agent for the plan panel |
| `GITHUB_TOKEN` | Injected by the platform's GitHub integration |

There is deliberately no direct-to-provider fallback. The gateway is where PII
redaction, token limits and per-route tracing live, and a bypass would skip all
three exactly when traffic is least supervised.

**The two routes differ in two ways, and both will bite you.** Base URL, because
each client appends its own suffix — LiteLLM's openai provider posts to
`{base}/chat/completions` so its base carries `/v1`, while `typesafe-sdk` posts
to `{base}/v1/systemone` so its base must not. And authentication, verified
against the live gateway on 2026-09-22:

| Route | Header it wants | Sending the other |
| --- | --- | --- |
| `/openai/*` | `X-Gateway-Key: <key>` | `401 Unauthorized` |
| `/jev/*` | `Authorization: Bearer <key>` | `401 Unauthorized` |

Each route has its own `route-auth` plugin instance, configured independently,
so this is a property of the gateway rather than of either SDK. The 401 body is
a bare `Unauthorized` with no hint about which header was expected, so if a
model call starts failing auth, check the scheme before anything else. In code
this lives in one place: `openai_headers()` and `jev_api_key()` in `gateway.py`.

### Reading gateway failures

The two failure codes mean very different things, and mistaking one for the other
wastes an afternoon:

| Status | Body | Cause |
| --- | --- | --- |
| `401` | `Unauthorized` | Wrong **auth scheme** for that route (see the table above), or a bad key. A code problem. |
| `421` | `misdirected request` | The tenant's vhost is not reachable from your current network. **Usually the VPN.** Not a code problem. |

Tell them apart quickly: a `421` hits *every* route including `GET /`, persists
after an HTTP/1.1 downgrade, and carries `x-envoy-upstream-service-time: 1` —
the edge rejects it without ever proxying upstream. A `401` is route-specific,
so one route keeps working while the other fails.

## What Jev changes

- **Priority and sentiment cannot come back malformed.** Previously a model that
  wrapped its JSON in fences or capitalised a key could silently default an issue
  to `low` and bury it — the reason `_extract_json` and `_coerce_enum` in
  `github.py` are as defensive as they are. Those guards remain, but they now
  only protect the fallback path rather than propping up the happy path.
- **Calibrated confidence per answer**, shown on each card and highlighted amber
  below 60% so a shaky score invites a second look instead of silent trust.
- **A continuous severity score** orders cards within a priority bucket, so the
  top of a HIGH run is no longer arbitrary. Rendered as a three-segment meter.
- **Two yes/no cross-checks.** When Jev sees a workaround or competitor mention
  that the write-up failed to extract, the card says so rather than showing
  nothing — it points a human at the threads worth reading.

If the Jev call fails, is disabled, or returns unusable answers, cards fall back
to the LLM's own enums and simply omit the confidence and severity fields.
