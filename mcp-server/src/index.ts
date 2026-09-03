/**
 * oauth-mcp-server — a self-contained OAuth 2.1 MCP server on Astro.
 *
 * One Express app is both the Authorization Server (discovery, dynamic client
 * registration, /authorize, /token via `mcpAuthRouter`) and the Resource Server
 * (a bearer-protected Streamable HTTP MCP endpoint at /mcp). Clients discover
 * everything from the server's own origin — no external IdP.
 *
 * Deployed as a frontend Astro agent: it serves HTTP on the injected PORT (80 in
 * production) and the platform routes its public host (ASTRO_EXTERNAL_AGENT_URL)
 * to it. The issuer/resource URLs are derived from that public URL so discovery
 * documents advertise reachable endpoints.
 */
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryOAuthProvider, SCOPES_SUPPORTED } from "./oauth-provider";
import { createMcpServer } from "./mcp-server";
import { mountLogin } from "./login";
import { initTelemetry, withSpan } from "./telemetry";

// Initialize tracing before anything creates spans.
initTelemetry();

const PORT = Number(process.env.PORT ?? 8787);

// Public origin: the agent's external URL on Astro, else localhost in dev.
// OAUTH_ISSUER_URL overrides both if you need to pin it.
const baseUrl = new URL(
  process.env.OAUTH_ISSUER_URL ??
    process.env.ASTRO_EXTERNAL_AGENT_URL ??
    `http://localhost:${PORT}`,
);
const mcpUrl = new URL("/mcp", baseUrl);
const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", baseUrl).href;

const provider = new InMemoryOAuthProvider();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // login form submissions

// Login screen handler (POST /login), paired with the form rendered by authorize().
mountLogin(app, provider);

// Authorization-server endpoints + Protected Resource Metadata. AS and RS share
// this origin; the protected resource is the /mcp endpoint. Must be mounted at
// the application root.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    baseUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: SCOPES_SUPPORTED,
    resourceName: "Astro OAuth MCP demo",
  }),
);

// Bearer-protected MCP endpoint, stateless Streamable HTTP (a fresh server +
// transport per request).
const requireAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

app.post("/mcp", requireAuth, async (req, res) => {
  const method = typeof req.body?.method === "string" ? req.body.method : "unknown";
  // Root span for the request; tool-call spans (created inside handleRequest)
  // nest under it via the active context.
  await withSpan(
    "mcp.request",
    { "mcp.method": method, "mcp.user.id": (req.auth?.extra?.userId as string) ?? "" },
    async () => {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
});

// Stateless mode: no server-initiated SSE stream or session teardown.
const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get("/mcp", requireAuth, methodNotAllowed);
app.delete("/mcp", requireAuth, methodNotAllowed);

// Liveness / human landing page (also keeps ingress health checks green).
app.get("/", (_req, res) => {
  res.status(200).send(`oauth-mcp-server — MCP endpoint: ${mcpUrl.href}`);
});

app.listen(PORT, () => {
  console.log(`[mcp-server] listening on :${PORT}`);
  console.log(`[mcp-server] issuer:   ${baseUrl.href}`);
  console.log(`[mcp-server] mcp:      ${mcpUrl.href}`);
});
