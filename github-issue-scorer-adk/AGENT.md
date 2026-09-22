---
description: "Scores open GitHub issues for sentiment and priority, streamed live into a web dashboard. Built on Google ADK + the AG-UI protocol."
tags:
  - github
  - triage
  - scoring
  - adk
  - ag-ui
  - dashboard
authors:
  - name: Simon Guerrier
    account: simon
repository:
  type: git
  url: https://github.com/Simwar/astro-demo.git
  directory: github-issue-scorer-adk
capabilities:
  - "Score a repo's open GitHub issues by priority, sentiment, competitor mentions, and workarounds"
  - "Stream each issue's score into a live dashboard as it's analyzed"
  - "Score a single issue by number, or the top N (max 50)"
integrations:
  - GitHub
  - Anthropic
---

# github-issue-scorer-adk

An ADK + AG-UI recreation of the github-issue-scorer, with a live web dashboard.
Give it a repository and it fetches the open issues and scores each one — a
one-line summary, a sentiment read (frustration / urgency / neutral / positive),
a priority (high / medium / low) with the reasoning, plus any competitor mentions
and workarounds surfaced in the thread. Cards fill in one at a time as scoring
streams over the AG-UI protocol.

## Architecture

A single container runs one FastAPI process on port 80:

- `POST /agui` — AG-UI SSE endpoint, served by `ag_ui_adk` in front of a Google
  ADK `LlmAgent`.
- `/` — the built React dashboard (static assets).

The agent's model and the per-issue scoring both run through the **Astro AI
gateway** (OpenAI-compatible) via LiteLLM, so there are no model keys to manage.
GitHub is reached over the REST API with the injected `GITHUB_TOKEN`.

The dashboard updates live because the scoring tool writes each issue's result
into ADK session **state**; `ag_ui_adk` emits that as AG-UI `STATE_SNAPSHOT` /
`STATE_DELTA` events, which the frontend merges and renders.

## Usage

Open the frontend URL that `ast project start` prints. Enter a repository:

- `owner/repo` — top 5 open issues
- `owner/repo 20` — top N (max 50)
- `owner/repo#123` — a single issue

## Limitations

- **Read-only.** It analyzes issues; it never writes to GitHub.
- **Per-token visibility.** It sees what the injected `GITHUB_TOKEN` can see.
- **Long threads truncated.** Bodies are capped at ~2000 chars and comments at
  ~500 to keep scoring fast and cheap.
- **Demo-scoped session.** State is in-memory and resets on restart.
