/**
 * The MCP server (resource server) and its demo tools.
 *
 * A fresh server is created per request in stateless Streamable HTTP mode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "astro-oauth-mcp",
    version: "0.1.0",
  });

  server.tool(
    "echo",
    "Echo back the provided text.",
    { text: z.string().describe("Text to echo back.") },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  server.tool(
    "add",
    "Add two numbers and return the sum.",
    { a: z.number(), b: z.number() },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );

  server.tool(
    "current_time",
    "Return the current server time as an ISO 8601 string.",
    {},
    async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
  );

  return server;
}
