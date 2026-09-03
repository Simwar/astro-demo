# oauth-mcp-server

A self-contained **OAuth 2.1 MCP server** for Astro — one service that is both the
authorization server (DCR + PKCE + token issuance) and the resource server (a
bearer-protected Streamable HTTP MCP endpoint with demo tools).

## Quick start

```bash
bun install
bun run dev        # http://localhost:8787  (MCP endpoint at /mcp)
```

Connect any MCP client to the `/mcp` URL — it runs the OAuth handshake for you,
showing a **login screen**. Sign in with a demo account:

> **alice / password** · **bob / password**

Then the client gets per-user access to the tools (`whoami`, `list_notes`,
`add_note`, `delete_note`, and a keyless third-party `weather` tool):

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
│   ├── index.ts          # Express app: AS router + /login + protected /mcp endpoint
│   ├── oauth-provider.ts  # In-memory OAuthServerProvider (clients, codes, tokens)
│   ├── login.ts           # Login + consent screen and the /login handler
│   ├── users.ts           # Demo user directory (alice / bob)
│   ├── notes-store.ts     # Per-user notes (the service this server owns)
│   ├── telemetry.ts       # OpenTelemetry: spans for requests, tool calls, outbound HTTP
│   └── mcp-server.ts      # MCP server + tools (whoami, *_note, weather)
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

## Tracing

The server emits OpenTelemetry spans so you see *what's happening inside*, not
just inbound requests:

```
mcp.request (method=tools/call, user=user-alice)
└─ mcp.tool/weather
   ├─ HTTP GET geocoding-api.open-meteo.com
   └─ HTTP GET api.open-meteo.com
```

Each `POST /mcp` is a span; each tool call is a child span tagged with the tool
name and the authenticated user; outbound third-party calls (the `weather`
tool) are child spans. Spans export to `OTEL_EXPORTER_OTLP_ENDPOINT`, which Astro
injects on deploy (`service.name` = `ASTRO_AGENT_NAME`). Locally the var is
unset, so tracing is a no-op and the server runs unchanged.

Manual spans are used deliberately — Node auto-instrumentation is unreliable
under Bun. The OAuth endpoints (`/authorize`, `/token`, `/register`) aren't
traced yet; add spans in `telemetry.ts` / the handlers if you want them.

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
- State is **in-memory** — clients, tokens, and notes reset on restart. For
  production, back `oauth-provider.ts` and `notes-store.ts` with a writable store
  (e.g. a `redis` knowledge entry, since the deployed filesystem is read-only).
- The login uses a **demo user directory** with plaintext passwords
  (`users.ts`). Swap it for your real identity provider before any non-demo use.
