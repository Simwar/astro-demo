/**
 * One-time interactive OAuth consent for the hosted MCP servers.
 *
 *   bun run authorize            # authorize every server that needs it
 *   bun run authorize jira       # authorize a single server by key
 *
 * MCPClient itself can't drive the interactive code exchange (it has no
 * finishAuth), so we run the canonical MCP SDK flow here: connect → catch
 * UnauthorizedError → open the consent URL → catch the redirect on a loopback
 * server → transport.finishAuth(code). Tokens land in the shared file store, so
 * the agent runtime (agent/index.ts) connects silently afterwards and the SDK
 * refreshes tokens in place as they expire.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import open from 'open';
import { CALLBACK_PORT, MCP_SERVERS, createProvider, type McpServerSpec } from './mcp/servers';

// Single loopback server reused across providers (we authorize sequentially).
let pendingResolve: ((code: string) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;

const server = Bun.serve({
  port: CALLBACK_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/oauth/callback') {
      return new Response('Not found', { status: 404 });
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      pendingReject?.(new Error(`${error}: ${url.searchParams.get('error_description') ?? ''}`));
      pendingResolve = pendingReject = null;
      return new Response(`Authorization failed: ${error}. You can close this tab.`, { status: 400 });
    }
    if (code && pendingResolve) {
      pendingResolve(code);
      pendingResolve = pendingReject = null;
      return new Response('Authorized ✓ — you can close this tab and return to the terminal.');
    }
    return new Response('No authorization in progress.', { status: 400 });
  },
});

async function authorize(spec: McpServerSpec): Promise<void> {
  const provider = createProvider(spec, async (authUrl) => {
    console.log(`\n→ ${spec.label}: opening your browser to authorize…`);
    console.log(`  If it doesn't open, visit:\n  ${authUrl.toString()}`);
    await open(authUrl.toString()).catch(() => {
      /* headless box: the printed URL above is the fallback */
    });
  });

  if (await provider.hasValidTokens()) {
    console.log(`✓ ${spec.label}: already authorized`);
    return;
  }

  const transport = new StreamableHTTPClientTransport(new URL(spec.url), { authProvider: provider });
  const client = new Client({ name: 'agent-mcp-authorize', version: '0.1.0' });

  // Arm the callback handler before connect() triggers the browser redirect.
  const codePromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
  });

  try {
    await client.connect(transport);
    // Connected without a redirect → tokens were already valid.
    await client.close();
    console.log(`✓ ${spec.label}: already authorized`);
    return;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  const code = await codePromise;
  await transport.finishAuth(code); // exchanges code → tokens, persisted via storage
  await client.close().catch(() => {});
  console.log(`✓ ${spec.label}: authorized`);
}

const requested = process.argv.slice(2);
const targets = requested.length
  ? MCP_SERVERS.filter((s) => requested.includes(s.key))
  : MCP_SERVERS;

if (requested.length && targets.length === 0) {
  console.error(`Unknown server(s): ${requested.join(', ')}. Known: ${MCP_SERVERS.map((s) => s.key).join(', ')}`);
  server.stop();
  process.exit(1);
}

let failed = false;
for (const spec of targets) {
  try {
    await authorize(spec);
  } catch (err) {
    failed = true;
    console.error(`✗ ${spec.label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

server.stop();
console.log(failed ? '\nDone with errors — re-run to retry the failed servers.' : '\nAll set. Start the agent with `ast project start`.');
process.exit(failed ? 1 : 0);
