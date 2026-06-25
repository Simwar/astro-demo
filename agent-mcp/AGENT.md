---
description: "Chatbot that answers questions across your Jira, Notion, and Postman workspaces via their official MCP servers."
tags:
  - chatbot
  - mcp
  - jira
  - notion
  - postman
  - cross-tool
  - oauth
authors:
  - name: Simon Guerrier
    account: simon
repository:
  type: git
  url: https://github.com/Simwar/astro-demo.git
  directory: agent-mcp
capabilities:
  - "Answer questions across Jira, Notion, and Postman in one conversation"
  - "Synthesize cross-tool answers and cite the source of each fact"
  - "Look up Jira issues, Notion pages, and Postman collections on demand"
  - "Connect each service from chat via OAuth — no API keys to paste"
integrations:
  - Jira
  - Notion
  - Postman
  - Anthropic
---

# cross-tool-assistant

The answer to "what's the status of this?" usually lives in three places at once:
the ticket is in **Jira**, the spec is in **Notion**, and the API it describes is
a collection in **Postman**. cross-tool-assistant stitches those together — ask a
question in plain language and it reads across all three to give you one grounded,
cited answer.

It connects to each product's **official hosted MCP server** over OAuth 2.1, so it
sees exactly what you can see, and there are no API keys to manage.

## Overview

cross-tool-assistant is a chat agent built on Mastra and the Astropods messaging
adapter. Its tools come live from three remote MCP servers:

- **Jira (Atlassian)** — issues, projects, sprints, comments (`jira_*` tools)
- **Notion** — pages, databases, and their content (`notion_*` tools)
- **Postman** — workspaces, collections, requests, and APIs (`postman_*` tools)

For each question it routes to the system that owns the answer, gathers from more
than one when a question spans tools, and grounds every claim in tool results —
citing the issue key, page title, or collection it came from rather than guessing.

## Usage

Chat with it in the Astropods playground (`http://localhost:3100` during local
dev) or any connected messaging adapter.

**Connecting a service** (one-time, per service):

1. Ask it to connect — *"connect Notion"*. It calls `connect_service` and replies
   with an authorization URL.
2. Open the URL and approve. On a deployed agent with an exposed endpoint the
   connection completes automatically; otherwise copy the `code` value from the
   redirect URL and paste it back so it can call `complete_connection`.
3. Ask *"what's connected?"* (`list_connections`) to confirm.

**Asking questions** once connected:

- *"What are the open issues in the PROJ sprint and who owns them?"*
- *"Find the Notion page that documents the checkout API."*
- *"Which Postman collection covers the payments endpoints?"*
- *"Which Notion doc explains the API behind PROJ-123?"* (spans all three)

OAuth tokens persist — in Redis when deployed (the container filesystem is
read-only), or a local file store in dev — and refresh automatically, so you only
authorize each service once.

## Limitations

- **Read-and-answer focus.** It's built for lookups and synthesis. It will confirm
  any create/update before calling a write tool.
- **Per-user access.** It sees only what the authorizing account can see in each
  workspace; it can't surface data you don't have access to.
- **Authorization is per service.** A service with no valid tokens is skipped at
  startup (the agent still runs); connect it from chat when you need it.
- **Notion MCP is Beta.** Its authorization server can intermittently return
  `invalid_target`; retrying the connect resolves it.
- **Local auto-complete is unavailable in Docker.** When run via the local
  container stack the OAuth redirect can't reach the in-container listener, so the
  paste step is required locally; hands-free completion applies to deployed agents
  that expose an endpoint.
