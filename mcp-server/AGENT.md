---
description: "A self-contained OAuth 2.1 MCP server with a login screen and per-user data, over its own notes service, deployable on Astro."
tags:
  - mcp
  - oauth
  - server
  - demo
authors:
  - name: Simon Guerrier
    account: simon
repository:
  type: git
  url: https://github.com/Simwar/astro-demo.git
  directory: mcp-server
capabilities:
  - "Authenticate users via a login + consent screen"
  - "Issue OAuth 2.1 tokens via dynamic client registration + PKCE"
  - "Serve per-user MCP tools over a bearer-protected Streamable HTTP endpoint"
  - "Advertise OAuth discovery and Protected Resource Metadata (RFC 9728)"
  - "Emit OpenTelemetry traces for MCP requests, tool calls, and outbound API calls"
---

# oauth-mcp-server

A minimal but complete **OAuth-protected MCP server** you can deploy on Astro. It
is both the **authorization server** (dynamic client registration, `/authorize`,
`/token`, PKCE) and the **resource server** (a bearer-protected Streamable HTTP
MCP endpoint) — so any MCP client can discover it, run the full OAuth flow, and
call its tools, with no external identity provider.

## Overview

Built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
One Express app exposes:

- **Authorization server** (`mcpAuthRouter`): `/.well-known/oauth-authorization-server`, `/register` (RFC 7591 dynamic client registration), `/authorize`, `/token` — OAuth 2.1 with PKCE.
- **Login screen** at `/authorize` → `/login`: `authorize()` renders a sign-in + consent page; the issued token is bound to the authenticated user.
- **Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`.
- **MCP endpoint** at `/mcp` (Streamable HTTP), gated by `requireBearerAuth`.

The server owns its data — a per-user **notes** store. The signed-in user's id
flows from the bearer token into each tool (`extra.authInfo.extra.userId`), so
every call only sees the caller's own notes. Issuer/resource URLs derive from
the agent's public URL (`ASTRO_EXTERNAL_AGENT_URL`) on deploy and `localhost` in
dev, so discovery documents always advertise reachable endpoints.

### Tools

| Tool | Description |
|------|-------------|
| `whoami` | Show the authenticated user. |
| `list_notes` | List your saved notes. |
| `add_note` | Save a new note. |
| `delete_note` | Delete one of your notes by id. |
| `weather` | Current weather for a city — a third-party call to the Open-Meteo public API (no key). |

Demo accounts (in-memory): `alice / password`, `bob / password`.

## Usage

The agent serves HTTP, so connect any MCP client to its `/mcp` URL; the client
performs the OAuth handshake automatically.

```bash
# MCP Inspector
npx @modelcontextprotocol/inspector
# then connect to http://localhost:8787/mcp (local) or https://<your-host>/mcp (deployed)

# Claude Code
claude mcp add --transport http oauth-demo http://localhost:8787/mcp
```

## Limitations

- **In-memory state.** Registered clients, auth codes, tokens, and notes reset
  on restart. Back the provider and the notes store with a persistent store
  (e.g. Redis) for anything real.
- **Demo user directory.** Users are a hardcoded list (`alice` / `bob`) with
  plaintext passwords. Swap `users.ts` for your real identity provider; never
  ship plaintext credentials.
- **Demo data/tools.** The notes service and the `weather` tool exist to show
  per-user data + a third-party API call, not to do real work.
