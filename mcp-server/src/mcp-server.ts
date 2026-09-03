/**
 * The MCP server (resource server) and its tools.
 *
 * Notes tools are scoped to the authenticated user — the user id arrives via
 * `extra.authInfo.extra.userId`, which the transport copies from the validated
 * bearer token. `weather` is a third-party API call (Open-Meteo, no key) for
 * color. A fresh server is created per request in stateless mode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { addNote, deleteNote, listNotes } from "./notes-store";
import { getUserById } from "./users";
import { tracedFetch, withSpan } from "./telemetry";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function requireUserId(extra: Extra): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== "string") {
    throw new Error("Not authenticated");
  }
  return userId;
}

/** Wrap a tool call in an `mcp.tool/<name>` span tagged with the caller. */
function toolSpan<T>(name: string, extra: Extra, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    `mcp.tool/${name}`,
    { "mcp.tool.name": name, "mcp.user.id": (extra.authInfo?.extra?.userId as string) ?? "" },
    fn,
  );
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "astro-oauth-mcp", version: "0.1.0" });

  server.tool("whoami", "Show the currently authenticated user.", {}, async (_args, extra) =>
    toolSpan("whoami", extra, async () => {
      const userId = requireUserId(extra);
      const user = getUserById(userId);
      return { content: [{ type: "text", text: user ? `${user.username} (${user.id})` : userId }] };
    }),
  );

  server.tool("list_notes", "List your saved notes.", {}, async (_args, extra) =>
    toolSpan("list_notes", extra, async () => {
      const notes = listNotes(requireUserId(extra));
      const text = notes.length
        ? notes.map((n) => `- [${n.id}] ${n.text}`).join("\n")
        : "(no notes yet)";
      return { content: [{ type: "text", text }] };
    }),
  );

  server.tool(
    "add_note",
    "Save a new note for the current user.",
    { text: z.string().describe("The note text.") },
    async ({ text }, extra) =>
      toolSpan("add_note", extra, async () => {
        const note = addNote(requireUserId(extra), text);
        return { content: [{ type: "text", text: `Saved note ${note.id}` }] };
      }),
  );

  server.tool(
    "delete_note",
    "Delete one of your notes by id.",
    { id: z.string().describe("The note id to delete.") },
    async ({ id }, extra) =>
      toolSpan("delete_note", extra, async () => {
        const ok = deleteNote(requireUserId(extra), id);
        return { content: [{ type: "text", text: ok ? `Deleted note ${id}` : `No note with id ${id}` }] };
      }),
  );

  server.tool(
    "weather",
    "Current weather for a city, via the Open-Meteo public API (no key).",
    { city: z.string().describe("City name, e.g. 'Lisbon'.") },
    async ({ city }, extra) =>
      toolSpan("weather", extra, async () => {
        const geo = (await tracedFetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
        ).then((r) => r.json())) as { results?: Array<{ name: string; country: string; latitude: number; longitude: number }> };
        const place = geo.results?.[0];
        if (!place) {
          return { content: [{ type: "text", text: `No location found for "${city}".` }], isError: true };
        }
        const forecast = (await tracedFetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m`,
        ).then((r) => r.json())) as { current?: { temperature_2m: number; wind_speed_10m: number } };
        const c = forecast.current;
        const text = c
          ? `${place.name}, ${place.country}: ${c.temperature_2m}°C, wind ${c.wind_speed_10m} km/h`
          : `Weather unavailable for ${place.name}.`;
        return { content: [{ type: "text", text }] };
      }),
  );

  return server;
}
