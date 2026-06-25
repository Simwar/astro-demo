/**
 * Shared MCP server + OAuth configuration.
 *
 * Both the agent runtime (agent/index.ts) and the one-time consent bootstrap
 * (agent/authorize.ts) build their providers from here so they share identical
 * client metadata, redirect URL, and — crucially — the same on-disk token store.
 *
 * Auth model: full OAuth 2.1 against each provider's official hosted MCP server,
 * using Dynamic Client Registration (RFC 7591) + PKCE. No static API keys.
 */
import { MCPClient, MCPOAuthClientProvider } from '@mastra/mcp';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { makeOAuthStorage } from './storage';

/**
 * Port the callback listener binds to. On a frontend deploy Astro injects
 * PORT=80 (the ingress target), so honoring PORT makes the callback reachable
 * with no extra config; locally it's 8808. OAUTH_CALLBACK_PORT overrides both.
 */
export const CALLBACK_PORT = Number(process.env.OAUTH_CALLBACK_PORT ?? process.env.PORT ?? 8808);

/** Path the agent serves and registers as the OAuth redirect target. */
export const CALLBACK_PATH = '/oauth/callback';

/**
 * Registered OAuth redirect URI, resolved in priority order:
 *   1. OAUTH_REDIRECT_URL          — explicit full-URL override.
 *   2. ASTRO_EXTERNAL_AGENT_URL    — the agent's own public URL, injected by
 *      Astro when the agent exposes a frontend endpoint. The provider then
 *      redirects to the agent's public host, which the ingress routes to the
 *      callback server below — so a deployed agent completes OAuth hands-free,
 *      no copy/paste.
 *   3. http://localhost:<port>     — local dev: loopback auto-complete, or the
 *      paste fallback when the browser can't reach the container.
 *
 * Falling back to localhost is safe: ASTRO_EXTERNAL_AGENT_URL is absent unless
 * an exposed endpoint actually exists to receive the redirect.
 */
function resolveRedirectUrl(): string {
  const explicit = process.env.OAUTH_REDIRECT_URL;
  if (explicit) return explicit;
  const external = process.env.ASTRO_EXTERNAL_AGENT_URL;
  if (external) return `${external.replace(/\/+$/, '')}${CALLBACK_PATH}`;
  return `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
}

export const REDIRECT_URL = resolveRedirectUrl();

export interface McpServerSpec {
  /** Stable key — also the MCPClient server name and tool namespace prefix. */
  key: string;
  /** Human label for logs / consent prompts. */
  label: string;
  /** Official hosted MCP endpoint (Streamable HTTP, SSE fallback). */
  url: string;
}

export const MCP_SERVERS: McpServerSpec[] = [
  // Atlassian exposes a dedicated endpoint for the OAuth 2.1 browser flow;
  // `/v1/mcp` (without authv2) is the generic/API-token endpoint and does not
  // advertise OAuth discovery to the client.
  { key: 'jira', label: 'Jira (Atlassian)', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
  { key: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { key: 'postman', label: 'Postman', url: 'https://mcp.postman.com/mcp' },
];

/** Public OAuth client (PKCE, no secret) registered dynamically per provider. */
function clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'Astropods agent-mcp',
    redirect_uris: [REDIRECT_URL],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function createProvider(
  spec: McpServerSpec,
  onRedirectToAuthorization?: (url: URL) => void | Promise<void>,
): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider({
    redirectUrl: REDIRECT_URL,
    clientMetadata: clientMetadata(),
    storage: makeOAuthStorage(spec.key),
    onRedirectToAuthorization,
  });
}

/** The servers that currently hold valid (or refreshable) OAuth tokens. */
export async function authorizedServers(): Promise<McpServerSpec[]> {
  const out: McpServerSpec[] = [];
  for (const spec of MCP_SERVERS) {
    if (await createProvider(spec).hasValidTokens()) out.push(spec);
  }
  return out;
}

/**
 * Build an MCPClient for the given servers. We only ever pass authorized
 * servers, so the client never attempts (and noisily fails) an unauthenticated
 * connection at boot. The client is rebuilt with a fresh `id` whenever a new
 * server is connected, so pass a unique id each time.
 */
export function buildMcpClient(specs: McpServerSpec[], id: string): MCPClient {
  const servers: Record<string, { url: URL; authProvider: MCPOAuthClientProvider }> = {};
  for (const spec of specs) {
    servers[spec.key] = { url: new URL(spec.url), authProvider: createProvider(spec) };
  }
  return new MCPClient({ id, servers });
}
