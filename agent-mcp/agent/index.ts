/**
 * agent-mcp - A cross-tool Q&A chatbot over the Jira, Notion, and Postman
 * hosted MCP servers.
 *
 * This agent uses Mastra's Agent class with the Astro adapter to connect
 * to the Astro messaging service via gRPC. Its tools come from three official
 * hosted MCP servers, reached over OAuth 2.1.
 *
 * Before the MCP tools work, complete the one-time consent flow:
 *   bun run authorize
 * Tokens are persisted to disk and refreshed automatically; if a server isn't
 * authorized yet its tools are skipped (logged below) and the agent still boots.
 *
 * Environment variables (automatically injected by 'astro dev'):
 *   ANTHROPIC_API_KEY - injected by anthropic model
 *   GRPC_SERVER_ADDR - injected by Astro messaging service
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { serve } from '@astropods/adapter-mastra';
import type { MCPClient } from '@mastra/mcp';
import { buildMcpClient, authorizedServers } from './mcp/servers';
import { createAuthTools } from './mcp/auth-tools';
import { oauthStorageInfo } from './mcp/storage';

const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: ':memory:',
  }),
});

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/traces';
    }
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'agent-mcp',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

// Connect to the hosted MCP servers and load their tools. Tools are namespaced
// as `<server>_<tool>` (e.g. jira_searchIssues, notion_search, postman_*).
// listToolsWithErrors() never throws: unauthorized/unreachable servers are
// reported and skipped so the agent still starts.
// Confirm where OAuth tokens are stored. On a deployed agent this must be Redis
// (the container FS is read-only); a `file` backend here means tokens would be
// lost on restart — surfaced loudly so it's caught in `ast project logs`.
const storage = oauthStorageInfo();
(storage.durable ? console.log : console.warn)(`[agent-mcp] OAuth token store: ${storage.detail}`);

// The MCP client holds only authorized servers, so boot makes no doomed
// unauthenticated connections (no "Authorization required…" wall). It's rebuilt
// when a service is connected. `mcpTools` is the snapshot the agent's dynamic
// `tools` reads, so newly-connected servers become usable without a restart.
let mcp: MCPClient | null = null;
let clientSeq = 0;
let mcpTools: Awaited<ReturnType<MCPClient['listToolsWithErrors']>>['tools'] = {};

async function refreshMcpTools(): Promise<void> {
  const specs = await authorizedServers();
  const previous = mcp;
  if (specs.length) {
    mcp = buildMcpClient(specs, `agent-mcp-clients-${++clientSeq}`);
    const { tools, errors } = await mcp.listToolsWithErrors();
    mcpTools = tools;
    const loaded = specs.filter((s) => !errors[s.key]).map((s) => s.label);
    console.log(`[agent-mcp] MCP tools ready: ${loaded.join(', ') || 'none'} (${Object.keys(tools).length} tools)`);
    for (const key of Object.keys(errors)) {
      console.warn(`[agent-mcp] ${key} failed to load despite tokens — re-authorize with connect_service.`);
    }
  } else {
    mcp = null;
    mcpTools = {};
    console.log('[agent-mcp] No services connected yet — use connect_service to authorize Jira, Notion, or Postman.');
  }
  if (previous) await previous.disconnect().catch(() => {});
}
await refreshMcpTools();

// In-chat OAuth: connect_service / complete_connection / list_connections.
// These let the agent authorize a service from inside the conversation, which
// is the only option once deployed (headless, read-only FS — no CLI bootstrap).
// On a successful connection the client + tool snapshot are rebuilt so the new
// server's tools become callable right away.
const authTools = createAuthTools(refreshMcpTools);

const instructions = `You are agent-mcp, an assistant that answers questions by reading across three connected systems via their MCP tools:

- Jira (Atlassian) — issues, projects, sprints, comments. Tools are namespaced \`jira_*\`.
- Notion — pages, databases, and their content. Tools are namespaced \`notion_*\`.
- Postman — workspaces, collections, requests, and APIs. Tools are namespaced \`postman_*\`.

How to work:
- Pick the system that owns the answer and call its tools to look it up. For questions that span systems (e.g. "which Notion doc explains the API behind PROJ-123?"), gather from each in turn, then synthesize one answer.
- Ground every factual claim in tool results. Never invent issue keys, page titles, URLs, IDs, or statuses — if a tool returns nothing, say so plainly.
- Cite where each fact came from (the issue key, page title, or collection name) so the user can verify it.
- If a request is ambiguous (which project? which workspace?), ask a brief clarifying question before searching.
- This agent is for reading and answering questions. If asked to create or modify data, confirm the exact change with the user before calling any write tool.

Connecting a service (OAuth):
- If a service isn't connected, or a tool fails with an authentication/authorization error, call \`connect_service\` for that service and give the user the returned authorization URL to open.
- After they approve, the connection usually completes automatically — call \`list_connections\` to confirm, then retry their request.
- If it didn't complete automatically, ask the user for the \`code\` value from the URL they were redirected to and call \`complete_connection\`.
- Use \`list_connections\` whenever you're unsure which services are currently authorized.`;

const agent = new Agent({
  id: 'agent-mcp',
  name: 'Agent Mcp',
  instructions,
  model: 'anthropic/claude-sonnet-4-5',
  // Dynamic so newly-connected MCP servers (via connect_service) are picked up
  // without a restart. Re-evaluated per request from the live snapshot.
  tools: () => ({ ...mcpTools, ...authTools }),
  memory,
  // Ensure traces include stable Astro metadata by default.
  // The collector endpoint is injected by `ast dev`.
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:agent-mcp'],
      metadata: {
        agent_id: 'agent-mcp',
      },
    },
  },
});

// Instantiate Mastra so it registers agents/observability plugins at startup.
// `serve(agent)` handles request serving; this constructor call wires runtime integration.
new Mastra({
  agents: {
    'agent-mcp': agent,
  },
  observability,
});

serve(agent);
