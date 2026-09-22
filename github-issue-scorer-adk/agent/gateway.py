"""Postman Fabric Gateway configuration.

Every model call — the ADK conversational loop, the per-issue prose call, and the
Jev scoring call — is routed through the gateway. The gateway stores the upstream
provider credentials and brokers auth on our behalf, so this container holds no
OpenAI or TypeSafe key of its own; only the gateway key.

There is deliberately no direct-to-provider fallback. The gateway is where PII
redaction, token limits and per-route tracing live, and a bypass would skip all
three exactly when traffic is least supervised.

Each client appends its own suffix, so the two base URLs differ:
  litellm's openai provider posts to {base}/chat/completions  -> base carries /v1
  typesafe-sdk posts to          {base}/v1/systemone          -> base must not
"""

from __future__ import annotations

import os

# Both clients want a value in their own auth slot and send it upstream as an
# Authorization header; the gateway substitutes the real provider credential, so
# it is never used. The TypeSafe client raises TypeSafeError without one.
BROKERED_BY_GATEWAY = "unused-gateway-brokers-auth"

GATEWAY_URL_VAR = "FABRIC_GATEWAY_URL"
GATEWAY_KEY_VAR = "FABRIC_GATEWAY_KEY"
GATEWAY_KEY_HEADER = "X-Gateway-Key"

# Model ids as exposed by the gateway's routes.
PROSE_MODEL = os.environ.get("PROSE_MODEL", "gpt-4o-mini")
JEV_MODEL = os.environ.get("JEV_MODEL", "jev-latest")


def _require(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(
            f"{name} is not set. All model calls are routed through the Postman "
            "Fabric Gateway — run 'ast configure' to set it."
        )
    return value


def gateway_origin() -> str:
    """Gateway origin, with any trailing slashes removed."""
    return _require(GATEWAY_URL_VAR).rstrip("/")


def gateway_headers() -> dict[str, str]:
    return {GATEWAY_KEY_HEADER: _require(GATEWAY_KEY_VAR)}


def openai_base_url() -> str:
    return f"{gateway_origin()}/openai/v1"


def jev_base_url() -> str:
    return f"{gateway_origin()}/jev"


def assert_configured() -> None:
    """Fail closed at startup.

    Without this the agent boots happily and then 401s on the first message,
    which is a much harder failure to read than a clear error at launch.
    """
    gateway_origin()
    gateway_headers()


def jev_enabled() -> bool:
    """Jev scoring can be disabled with JEV_ENABLED=0 to compare against
    LLM-only scoring. This switches off the Jev *questions*, not the transport —
    there is no env var that routes traffic around the gateway."""
    return (os.environ.get("JEV_ENABLED") or "").strip() != "0"
