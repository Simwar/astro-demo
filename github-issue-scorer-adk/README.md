# github-issue-scorer-adk

An [Astropods](https://astropods.com) agent that scores a repository's open
GitHub issues for **sentiment** and **priority** and streams the results into a
live web dashboard. Built on **Google ADK** and the **AG-UI protocol** (a Python
recreation of the Mastra/TS `github-issue-scorer`).

## Stack

| Layer | Choice |
| --- | --- |
| Agent framework | Google ADK (`google-adk`), Python |
| UI protocol | AG-UI via `ag_ui_adk` (FastAPI SSE at `/agui`) |
| Model | Claude via the Astro AI gateway (OpenAI-compatible), through LiteLLM |
| Frontend | React + Vite using `@ag-ui/client`, served as static files by FastAPI |
| GitHub | REST API via `httpx` with the injected `GITHUB_TOKEN` |

One container, one FastAPI process on port 80: `/agui` (AG-UI) + `/` (dashboard).

## Layout

```
agent/
  main.py     FastAPI app: /agui endpoint + static SPA mount + uvicorn
  agent.py    ADK LlmAgent + ag_ui_adk ADKAgent bridge
  model.py    LiteLlm pointed at the Astro AI gateway
  tools.py    score_github_issues — writes results into session state (live UI)
  github.py   GitHub REST client + per-issue LLM scoring + normalization
frontend/     React/Vite dashboard (built to ../static in the Docker image)
```

## Local development

The platform injects `ASTRO_GATEWAY_URL`, `ASTRO_GATEWAY_API_KEY`, `GITHUB_TOKEN`,
and `PORT`. The simplest path is the Astro stack:

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
