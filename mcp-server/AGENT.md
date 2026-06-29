---
description: "A self-contained OAuth 2.1 MCP server — authorization server + resource server with demo tools — deployable on Astro."
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
  - "Serve MCP tools over a bearer-protected Streamable HTTP endpoint"
  - "Issue OAuth 2.1 tokens via dynamic client registration + PKCE"
  - "Advertise OAuth discovery and Protected Resource Metadata (RFC 9728)"
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
- **Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`.
- **MCP endpoint** at `/mcp` (Streamable HTTP), gated by `requireBearerAuth`.

Issuer and resource URLs are derived from the agent's public URL
(`ASTRO_EXTERNAL_AGENT_URL`) on deploy, and `localhost` in dev, so discovery
documents always advertise reachable endpoints.

### Demo tools

| Tool | Description |
|------|-------------|
| `echo` | Echo back the provided text. |
| `add` | Add two numbers. |
| `current_time` | Return the current server time (ISO 8601). |

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

- **In-memory state.** Registered clients, auth codes, and tokens reset on
  restart. Back the provider with a persistent store (e.g. Redis) for anything
  real.
- **Auto-approves consent.** `authorize()` issues a code without a login/consent
  screen — it exercises the full OAuth/PKCE/DCR machinery but performs no user
  authentication. Add a real login step before using this beyond a demo.
- **Demo tools only.** `echo` / `add` / `current_time` exist to prove the
  transport and auth, not to do real work.
