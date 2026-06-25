/**
 * In-chat OAuth tools — the deploy-safe alternative to `bun run authorize`.
 *
 * A deployed Astro agent is headless (no browser to open) and runs on a
 * read-only filesystem, so the CLI bootstrap can't be used there. These tools
 * let the agent drive consent from inside the conversation instead:
 *
 *   connect_service(service)        -> returns a URL for the user to open
 *   complete_connection(service,code) -> finishes auth from the pasted code
 *   list_connections()              -> which services are authorized
 *
 * Completion path:
 *   - Local dev: a loopback listener on CALLBACK_PORT catches the redirect and
 *     finishes automatically — the user just clicks the link.
 *   - Deployed: nothing serves localhost, so the user copies the `code` query
 *     param from the redirected URL and calls complete_connection. No public
 *     endpoint or writable FS needed (tokens go to Redis).
 *
 * Single-operator scope: one in-flight authorization per service at a time.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CALLBACK_PATH, CALLBACK_PORT, MCP_SERVERS, REDIRECT_URL, createProvider, type McpServerSpec } from './servers';

interface Pending {
  spec: McpServerSpec;
  transport: StreamableHTTPClientTransport;
  state: string;
}

function specOf(service: string): McpServerSpec {
  const spec = MCP_SERVERS.find((s) => s.key === service);
  if (!spec) throw new Error(`Unknown service: ${service}`);
  return spec;
}

/**
 * @param onConnected called after a successful connection; the agent rebuilds its
 *                    MCP client + tool snapshot here so the new server is usable at once
 */
export function createAuthTools(onConnected?: () => Promise<void> | void) {
  const pending = new Map<string, Pending>(); // keyed by server key

  async function finish(spec: McpServerSpec, code: string): Promise<void> {
    // Prefer the in-flight transport from connect_service. If it's gone (e.g. the
    // deployed instance restarted between connect and paste), rebuild one: the
    // PKCE verifier + DCR client registration were persisted to storage, so a
    // fresh transport/provider can still complete the exchange.
    const transport =
      pending.get(spec.key)?.transport ??
      new StreamableHTTPClientTransport(new URL(spec.url), { authProvider: createProvider(spec) });
    await transport.finishAuth(code); // exchanges code -> tokens, persisted via storage
    pending.delete(spec.key);
    await onConnected?.(); // tokens now exist -> rebuild client so jira_/notion_/postman_ tools appear
  }

  // Best-effort loopback listener for local dev. In deployment it never
  // receives traffic; the paste flow (complete_connection) covers that case.
  try {
    Bun.serve({
      port: CALLBACK_PORT,
      fetch: async (req) => {
        const url = new URL(req.url);
        // Liveness/root: keep non-callback paths 200 so a frontend-ingress
        // health check on this port passes.
        if (url.pathname !== CALLBACK_PATH) return new Response('agent-mcp oauth callback', { status: 200 });
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        if (error) return new Response(`Authorization failed: ${error}`, { status: 400 });
        if (!code || !state) return new Response('Missing code/state', { status: 400 });
        const entry = [...pending.values()].find((p) => p.state === state);
        if (!entry) return new Response('No matching authorization in progress.', { status: 400 });
        try {
          await finish(entry.spec, code);
          return new Response(`${entry.spec.label} connected — you can close this tab and return to the chat.`);
        } catch (e) {
          return new Response(`Failed to complete: ${(e as Error).message}`, { status: 500 });
        }
      },
    });
    console.log(`[agent-mcp] OAuth callback listening on :${CALLBACK_PORT}; redirect_uri=${REDIRECT_URL}`);
  } catch {
    // Port unavailable (e.g. taken by `bun run authorize`, or unsupported env).
    // The paste flow still works.
  }

  const serviceEnum = z.enum(MCP_SERVERS.map((s) => s.key) as [string, ...string[]]);

  const connect_service = createTool({
    id: 'connect_service',
    description:
      'Start connecting one of the backing services (jira, notion, postman) via OAuth. Returns an authorization URL the user must open in their browser. Use this when a service is not yet connected or one of its tools reports an authentication error.',
    inputSchema: z.object({ service: serviceEnum.describe('Which service to connect.') }),
    execute: async ({ service }) => {
      const spec = specOf(service);
      let authUrl = '';
      const provider = createProvider(spec, (u) => {
        authUrl = u.toString();
      });

      if (await provider.hasValidTokens()) {
        return { status: 'already_connected', service };
      }

      const transport = new StreamableHTTPClientTransport(new URL(spec.url), { authProvider: provider });
      const client = new Client({ name: 'agent-mcp-connect', version: '0.1.0' });
      try {
        await client.connect(transport);
        await client.close();
        return { status: 'already_connected', service };
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
      }

      const state = new URL(authUrl).searchParams.get('state') ?? '';
      pending.set(spec.key, { spec, transport, state });
      return {
        status: 'authorization_required',
        service,
        authorizationUrl: authUrl,
        instructions:
          `Open this URL to authorize ${spec.label}. If your browser can reach this agent, the connection completes automatically. ` +
          'Otherwise, after approving you will be redirected to a URL containing a `code=` parameter — copy that code value and provide it so I can call complete_connection.',
      };
    },
  });

  const complete_connection = createTool({
    id: 'complete_connection',
    description:
      'Finish connecting a service after the user authorized it in the browser, using the `code` value from the redirect URL. Only needed when automatic completion did not happen (e.g. a deployed agent that cannot receive the browser redirect).',
    inputSchema: z.object({
      service: serviceEnum.describe('Which service is being connected.'),
      code: z.string().describe('The `code` query-parameter value from the redirect URL.'),
    }),
    execute: async ({ service, code }) => {
      const spec = specOf(service);
      await finish(spec, code);
      return { status: 'connected', service };
    },
  });

  const list_connections = createTool({
    id: 'list_connections',
    description: 'List which backing services (jira, notion, postman) are currently authorized.',
    inputSchema: z.object({}),
    execute: async () => {
      const connected: Record<string, boolean> = {};
      for (const spec of MCP_SERVERS) {
        connected[spec.key] = await createProvider(spec).hasValidTokens();
      }
      return { connected };
    },
  });

  return { connect_service, complete_connection, list_connections };
}
