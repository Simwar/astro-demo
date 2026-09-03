/**
 * OpenTelemetry tracing for the MCP server.
 *
 * Manual spans (not Node auto-instrumentation, which is unreliable under Bun):
 * we wrap the MCP request, each tool call, and outbound HTTP ourselves. Exports
 * to OTEL_EXPORTER_OTLP_ENDPOINT (injected by Astro on deploy); when that's
 * unset (local dev) the global tracer is a no-op, so withSpan/tracedFetch still
 * run the work and just don't emit spans.
 */
import { SpanKind, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "oauth-mcp-server";
let provider: NodeTracerProvider | undefined;

export function initTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.log("[mcp-server] telemetry: OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled");
    return;
  }
  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.ASTRO_AGENT_NAME ?? TRACER_NAME,
      [ATTR_SERVICE_VERSION]: process.env.ASTRO_AGENT_BUILD ?? "dev",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
  });
  provider.register();
  console.log(`[mcp-server] telemetry: exporting traces to ${url}`);

  // Flush buffered spans on shutdown. Adding a listener replaces Node's default
  // terminate behavior, so we exit explicitly.
  const shutdown = async () => {
    try {
      await provider?.shutdown();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Run `fn` inside a span; records exceptions and always ends the span. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return getTracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** fetch() wrapped in a CLIENT span — for outbound third-party calls. */
export async function tracedFetch(url: string, init?: RequestInit): Promise<Response> {
  return withSpan(
    `HTTP ${init?.method ?? "GET"}`,
    { "http.request.method": init?.method ?? "GET", "url.full": url, "server.address": new URL(url).host },
    async (span) => {
      const res = await fetch(url, init);
      span.setAttribute("http.response.status_code", res.status);
      return res;
    },
    SpanKind.CLIENT,
  );
}
