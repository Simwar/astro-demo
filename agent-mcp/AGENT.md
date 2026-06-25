---
description: "Cross-tool Q&A chatbot over the Jira, Notion, and Postman hosted MCP servers."
tags: ["chatbot", "mcp", "jira", "notion", "postman"]
authors: []
capabilities:
  - "Answer questions by reading across Jira, Notion, and Postman"
  - "Synthesize cross-tool answers and cite their source"
integrations:
  - "anthropic"
  - "jira"
  - "notion"
  - "postman"
---

agent-mcp is a chatbot that answers questions by reading across three connected
systems through their official hosted MCP servers:

- **Jira (Atlassian)** — issues, projects, sprints, comments (`jira_*` tools)
- **Notion** — pages, databases, and their content (`notion_*` tools)
- **Postman** — workspaces, collections, requests, and APIs (`postman_*` tools)

Each server is reached over OAuth 2.1 (dynamic client registration + PKCE).
Authorize from the chat — ask the agent to connect a service and it returns a
URL to approve (`connect_service` / `complete_connection` / `list_connections`).
This works both locally and on a deployed (headless) agent. Tokens persist in
Redis when deployed (the container FS is read-only) or in a local file
otherwise, and refresh automatically.
