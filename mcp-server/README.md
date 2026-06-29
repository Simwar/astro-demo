# oauth-mcp-server

A self-contained **OAuth 2.1 MCP server** for Astro — one service that is both the
authorization server (DCR + PKCE + token issuance) and the resource server (a
bearer-protected Streamable HTTP MCP endpoint with demo tools).

## Quick start

```bash
bun install
bun run dev        # http://localhost:8787  (MCP endpoint at /mcp)
```

Connect any MCP client to the `/mcp` URL — it runs the OAuth handshake for you:

```bash
# MCP Inspector
npx @modelcontextprotocol/inspector       # connect to http://localhost:8787/mcp

# Claude Code
claude mcp add --transport http oauth-demo http://localhost:8787/mcp
```

## Endpoints

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-authorization-server` | OAuth AS metadata (RFC 8414) |
| `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728) |
| `/register` | Dynamic client registration (RFC 7591) |
| `/authorize`, `/token` | OAuth 2.1 authorization-code flow with PKCE |
| `/mcp` | MCP endpoint (Streamable HTTP), requires a Bearer token |

## Project structure

```
mcp-server/
├── src/
│   ├── index.ts          # Express app: AS router + protected /mcp endpoint
│   ├── oauth-provider.ts  # In-memory OAuthServerProvider (clients, codes, tokens)
│   └── mcp-server.ts      # MCP server + demo tools (echo, add, current_time)
├── astropods.yml          # Frontend-only Astro agent
├── Dockerfile
└── package.json
```

## How auth resolves

The issuer / resource URLs come from the public URL so discovery advertises
reachable endpoints:

1. `OAUTH_ISSUER_URL` — explicit override.
2. `ASTRO_EXTERNAL_AGENT_URL` — the agent's public URL, injected on deploy.
3. `http://localhost:<PORT>` — local dev.

## Deploying to Astro

This is a **frontend-only** agent (`agent.interfaces.frontend: true`), so the
platform provisions a public host, injects `ASTRO_EXTERNAL_AGENT_URL` and
`PORT=80`, and routes the host to the container.

```bash
ast project start      # local
# deploy via the platform; then connect a client to https://<your-host>/mcp
```

Notes:
- The container runs as **root** so it can bind the privileged `:80` the ingress
  targets (see `Dockerfile`).
- State is **in-memory** — clients/tokens reset on restart. For production, back
  `oauth-provider.ts` with a writable store (e.g. a `redis` knowledge entry,
  since the deployed filesystem is read-only).
- `authorize()` **auto-approves** (no login screen). Add real authentication
  before any non-demo use.
