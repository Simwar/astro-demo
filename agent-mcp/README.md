# agent-mcp

A chatbot that answers questions by reading across **Jira**, **Notion**, and
**Postman**, using each product's official hosted MCP server over OAuth 2.1.

## Quick start

```bash
# Install dependencies
bun install

# Start the agent locally
ast project start
```

The playground is at <http://localhost:3100>. Authorize the services from inside
the chat — just ask, e.g. "connect Notion" (see [Authorization](#authorization-oauth)).

## Project structure

```
agent-mcp/
├── agent/
│   ├── index.ts          # Agent entry point (loads MCP tools, defines behavior)
│   ├── authorize.ts      # Optional local CLI consent (`bun run authorize`)
│   └── mcp/
│       ├── servers.ts    # Server endpoints + OAuth provider/client config
│       ├── auth-tools.ts # In-chat connect_service / complete_connection / list_connections
│       └── storage.ts    # OAuth token store (Redis when deployed, file locally)
├── astropods.yml         # Agent specification
├── Dockerfile            # Agent container
├── .env                  # Environment variables (set via ast project configure; not committed)
└── package.json
```

## Integrations

| Integration       | Type      | MCP endpoint                              | Auth     |
|-------------------|-----------|-------------------------------------------|----------|
| Anthropic         | Model API | —                                         | `ANTHROPIC_API_KEY` |
| Jira (Atlassian)  | MCP tools | `https://mcp.atlassian.com/v1/mcp/authv2` | OAuth 2.1 |
| Notion            | MCP tools | `https://mcp.notion.com/mcp`              | OAuth 2.1 |
| Postman           | MCP tools | `https://mcp.postman.com/mcp`             | OAuth 2.1 |

Tools are namespaced per server: `jira_*`, `notion_*`, `postman_*`.

## Authorization (OAuth)

The MCP servers use OAuth 2.1 with Dynamic Client Registration + PKCE — no API
keys to paste. A server that isn't authorized yet is logged and skipped at
startup; the agent still boots and can connect it on demand.

### From the chat (works locally and when deployed)

The agent exposes three tools — `connect_service`, `complete_connection`,
`list_connections` — so you authorize from the conversation:

1. Ask the agent to connect a service (e.g. "connect Jira"). It calls
   `connect_service` and replies with an authorization URL.
2. Open the URL and approve.
   - **Local:** your browser hits the loopback listener and the connection
     completes automatically.
   - **Deployed (headless):** there's nothing at `localhost` to catch the
     redirect, so copy the `code` value from the URL you land on and paste it
     back. The agent calls `complete_connection` to finish.
3. The agent re-lists that server's tools and answers your original question.

Tokens are refreshed automatically thereafter.

### From the CLI (optional, local only)

`bun run authorize` does the same browser flow from the terminal (opens each
consent screen, captures the redirect, stores tokens). Convenient for local dev;
not usable on a deployed agent (headless + read-only filesystem).

### Token storage

| Environment | Backend | Notes |
|-------------|---------|-------|
| Deployed    | Redis (`REDIS_URL`, provisioned by `knowledge.cache`) | Required — the container filesystem is read-only. |
| Local dev   | JSON file under `OAUTH_STORE_DIR` (default `./.astro-oauth`, gitignored) | Used when `REDIS_URL` is absent. |

The selector lives in `agent/mcp/storage.ts` and switches automatically on
`REDIS_URL`.

## Configuration

No OAuth config is required — the platform-injected vars below are resolved
automatically. The agent also honors a few optional env overrides if you ever
set them, but they are **not** declared as deploy inputs (nothing to fill in).

Platform-injected (deploy):

| Variable                  | Purpose                                                        |
|---------------------------|----------------------------------------------------------------|
| `REDIS_URL`               | Token store, from `knowledge.cache` (required; read-only FS).  |
| `ASTRO_EXTERNAL_AGENT_URL`| Public URL; the OAuth redirect is forged from it when present. |
| `PORT`                    | `=80` for a frontend deploy; the callback listener binds it.   |

Optional env overrides (defaults shown; rarely needed):

| Variable              | Default                                | Purpose                                            |
|-----------------------|----------------------------------------|----------------------------------------------------|
| `OAUTH_REDIRECT_URL`  | forged / `http://localhost:8808/oauth/callback` | Force a specific registered redirect URI. |
| `OAUTH_CALLBACK_PORT` | `PORT` ?? `8808`                       | Force the callback listener port.                  |
| `OAUTH_STORE_DIR`     | `./.astro-oauth`                       | File token-store dir (local only; ignored if `REDIS_URL` set). |
