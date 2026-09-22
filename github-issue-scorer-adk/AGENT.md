---
description: "Triages a repo's open GitHub issues by priority and sentiment, streamed live into a dashboard — with a calibrated confidence on every score, from Jev."
tags:
  - github
  - triage
  - scoring
  - product-management
  - sentiment-analysis
  - dashboard
  - jev
  - ag-ui
  - adk
authors:
  - name: Simon Guerrier
    account: simon
repository:
  type: git
  url: https://github.com/Simwar/astro-demo.git
  directory: github-issue-scorer-adk
capabilities:
  - "Triage a repo's open GitHub issues by priority, sentiment, and user impact"
  - "Show how confident the model is in each score, and flag the shaky ones"
  - "Rank issues by severity so the top of the list is the right place to start"
  - "Surface competitor mentions and workarounds buried in comment threads"
  - "Fill in a live board as each issue is scored, rather than waiting for a report"
  - "Score one issue by number, or up to 50 at a time"
  - "Hand the scored backlog to a planner agent for a remediation plan"
integrations:
  - GitHub
  - OpenAI
  - TypeSafe Jev
  - Postman Fabric Gateway
---

# GitHub Issue Scorer

Your backlog has four hundred open issues and you have Tuesday afternoon. Which
three actually matter?

Point this agent at a repository and it reads each open issue — the body and the
whole comment thread — then fills a live board as it goes. Every card tells you
how urgent the issue is, how the reporter feels about it, and how badly users are
actually impacted. The frustrated thread where someone quietly posted a
workaround, or mentioned they're evaluating a competitor, stops being invisible.

## What you get

- **A board that fills in as it thinks** — cards appear immediately as
  placeholders and resolve one by one, so you can start reading the first result
  while the rest are still being scored.
- **Scores you can calibrate your trust against** — every priority and sentiment
  carries a confidence figure. Anything under 60% is highlighted, so a shaky
  judgement invites a second look instead of sitting there looking authoritative.
  Hover it for the full breakdown.
- **A real ranking, not three buckets** — an impact score orders issues *within*
  each priority, so the top of a `HIGH` run is genuinely where to start. Each
  card says what its impact level means in plain words.
- **The things a summary usually loses** — competitor comparisons and
  user-discovered workarounds get pulled out of the thread. And when the agent
  detects one it couldn't cleanly quote, the card says so rather than showing
  nothing — a nudge to go read that thread yourself.
- **An action plan on request** — hand the scored backlog to a companion planner
  agent and get back a sequenced remediation plan. *(Optional; skip it and
  everything else still works.)*

## Usage

Open the dashboard, type a repository, choose how many issues to score, and hit
the button.

| You want | Do this |
|---|---|
| The 5 most recent open issues | Enter `pallets/flask`, leave the count at 5 |
| A deeper sweep | Enter `vercel/next.js`, set the count to 20 |
| One specific issue | Enter `rails/rails#50234` |

You can also just talk to it — *"score the top 10 issues in ag-ui-protocol/ag-ui"*
works, and so does *"now give me an action plan"* once it has finished.

Cards sort themselves highest-priority first, then by impact within each
priority, so the list arrives in the order you should work through it.

## How the scoring works

Two models, each doing the half it is actually good at.

**Jev** makes the judgements — priority, sentiment, and impact. It is a decision
model rather than a chat model: it picks from a fixed set of answers and returns
a probability for each, so it cannot invent a priority that doesn't exist or
mangle its own output. That is where the confidence figures come from.

**An LLM** does the writing — the summary, the reasoning behind each score, and
pulling competitor names and workarounds out of the comments.

They run at the same time, so you don't wait for both. If Jev is unavailable the
agent keeps working and falls back to the LLM's own judgement; you'll just see
the confidence and impact figures disappear from the cards.

## Limitations

- **Read-only.** It analyses issues; it never comments, labels, or closes
  anything on GitHub.
- **Open issues only.** Closed issues and pull requests are skipped.
- **Up to 50 issues per run**, and it only sees what the connected GitHub
  account can see — private repos need access.
- **Very long threads get trimmed.** Issue bodies and individual comments are
  truncated, and only the first 120 comments are scored, so a thousand-comment
  epic will lose some nuance.
- **Sessions don't persist.** Scores live as long as the page is open; reloading
  starts fresh.
