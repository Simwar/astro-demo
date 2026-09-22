"""FastAPI entry point.

Serves the AG-UI SSE endpoint at /agui and the built React dashboard at /.
The platform injects PORT=80 for a frontend agent; locally it defaults to the
dev.interfaces.frontend.port (8808).
"""

from __future__ import annotations

import os

# Fail closed before anything else: every model call goes through the Fabric
# Gateway, so a missing key is a startup error rather than a first-message 401.
from .gateway import assert_configured

assert_configured()

# Initialise OpenTelemetry BEFORE importing the agent, so ADK's spans (and our
# own) attach to the configured global provider from the very first request.
from .telemetry import init_telemetry

_TELEMETRY_ON = init_telemetry()

import uvicorn
from ag_ui_adk import add_adk_fastapi_endpoint
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .agent import adk_middleware

app = FastAPI(title="github-issue-scorer-adk")

# Register the AG-UI endpoint BEFORE the static mount. StaticFiles at "/" is a
# catch-all; explicit routes registered first still win, so /agui isn't shadowed.
add_adk_fastapi_endpoint(app, adk_middleware, path="/agui")

# Local dev serves the frontend from Vite (with a /agui proxy), so the built
# assets may be absent — only mount them when present.
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.isdir(_STATIC_DIR):
    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="spa")


def main() -> None:
    port = int(os.environ.get("PORT", "8808"))
    print(
        f"[scorer] telemetry: {'exporting to ' + os.environ['OTEL_EXPORTER_OTLP_ENDPOINT'] if _TELEMETRY_ON else 'disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)'}"
    )
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
