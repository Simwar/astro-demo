"""OpenTelemetry wiring for Astro.

This is a *frontend* ADK agent: it serves its own HTTP surface and never calls
an Astropods `serve()` adapter, and ADK isn't a first-party adapter — so the
OTEL SDK is the entire telemetry path (per the wire-astropods-telemetry skill).

`init_telemetry()` configures a global TracerProvider exporting over OTLP/HTTP to
`OTEL_EXPORTER_OTLP_ENDPOINT` (injected by the runner). Once the provider is set,
ADK's own spans (agent invocation, main-model LLM calls, tool execution) export
automatically; we add explicit spans with the backend-recognized attributes
(below) around the work ADK doesn't see — the scoring tool and the per-issue
LiteLLM generations.

If the endpoint is unset (running outside `ast project start`), we skip setup and
every span falls back to the API's no-op tracer — the agent runs, telemetry is
silently dropped.

Recognized attribute keys (Langfuse/OTel gen_ai conventions the collector reads):
"""

from __future__ import annotations

import os

from opentelemetry import trace

# --- Attribute keys the backend promotes to dedicated fields -----------------
OBS_TYPE = "langfuse.observation.type"       # e.g. "generation" | "span"
OBS_INPUT = "langfuse.observation.input"
OBS_OUTPUT = "langfuse.observation.output"
TRACE_INPUT = "langfuse.trace.input"
TRACE_OUTPUT = "langfuse.trace.output"
USER_ID = "langfuse.user.id"
SESSION_ID = "langfuse.session.id"
GEN_MODEL = "gen_ai.request.model"
GEN_IN_TOKENS = "gen_ai.usage.input_tokens"
GEN_OUT_TOKENS = "gen_ai.usage.output_tokens"

_TRACER_NAME = "github-issue-scorer-adk"


def _resolve_traces_endpoint(raw: str) -> str:
    """OTLP/HTTP wants the full traces path; the runner injects a base URL.
    Mirror the platform's own resolver: append /v1/traces if it's just a root."""
    raw = raw.strip()
    if raw.endswith("/v1/traces"):
        return raw
    return raw.rstrip("/") + "/v1/traces"


def init_telemetry() -> bool:
    """Configure the global TracerProvider. Returns True if exporting is enabled.

    Call this once, before the agent runs. Safe to call with no endpoint set
    (returns False, leaves the no-op tracer in place)."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return False

    # Imported lazily so the module stays importable even if the SDK/exporter
    # aren't present (e.g. minimal test env).
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )

    resource = Resource.create(
        {
            "service.name": os.environ.get("ASTRO_AGENT_NAME", _TRACER_NAME),
            "service.version": os.environ.get("ASTRO_AGENT_BUILD", "dev"),
        }
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=_resolve_traces_endpoint(endpoint))
        )
    )
    trace.set_tracer_provider(provider)
    return True


def get_tracer() -> "trace.Tracer":
    return trace.get_tracer(_TRACER_NAME)
