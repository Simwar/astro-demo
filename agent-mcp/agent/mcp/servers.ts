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

/** Loopback port the local auto-complete listener binds to. */
export const CALLBACK_PORT = Number(process.env.OAUTH_CALLBACK_PORT ?? 8808);

/**
 * Registered OAuth redirect URI. Defaults to localhost, which every provider
 * accepts for public clients. Locally a loopback listener captures the code;
 * when deployed (headless) the user copies the `code` from the redirected URL
 * and pastes it into the chat — no public endpoint required.
 */
export const REDIRECT_URL = process.env.OAUTH_REDIRECT_URL ?? `http://localhost:${CALLBACK_PORT}/oauth/callback`;

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

/**
 * Build an MCPClient wired to all three servers using the persisted OAuth
 * tokens. If a server has no valid tokens yet, listTools() logs and skips it
 * (the user must run `bun run authorize` first) — the agent still boots.
 */
export function buildMcpClient(): MCPClient {
  const servers: Record<string, { url: URL; authProvider: MCPOAuthClientProvider }> = {};
  for (const spec of MCP_SERVERS) {
    servers[spec.key] = { url: new URL(spec.url), authProvider: createProvider(spec) };
  }
  return new MCPClient({ id: 'agent-mcp-clients', servers });
}
