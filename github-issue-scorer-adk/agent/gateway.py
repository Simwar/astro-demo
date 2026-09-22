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

The two routes also AUTHENTICATE DIFFERENTLY. Verified against the live gateway
on 2026-09-22:

  /openai/*   X-Gateway-Key: <key>          (its own Authorization is ignored)
  /jev/*      Authorization: Bearer <key>   (X-Gateway-Key is rejected outright)

Each route carries its own route-auth plugin instance, configured independently,
so the asymmetry is a property of the gateway config rather than a bug here.
Sending the wrong scheme returns a bare `401 Unauthorized` with no hint as to
which header it wanted, so keep the two paths clearly separated below.
"""

from __future__ import annotations

import os

# The OpenAI route authenticates on X-Gateway-Key and ignores Authorization, but
# the openai/litellm clients insist on *some* api_key and always send it as a
# bearer token. This is the value they send; the gateway pays it no attention.
# The Jev route is the opposite case — there the key goes in api_key itself, see
# jev_api_key() below.
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


def gateway_key() -> str:
    return _require(GATEWAY_KEY_VAR)


def openai_headers() -> dict[str, str]:
    """Auth for the /openai route: the key rides in X-Gateway-Key."""
    return {GATEWAY_KEY_HEADER: gateway_key()}


def jev_api_key() -> str:
    """Auth for the /jev route: the key rides in Authorization: Bearer, which is
    exactly what typesafe-sdk does with `api_key`. So the gateway key *is* the
    api_key here — no custom header, and no placeholder."""
    return gateway_key()


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
    gateway_key()


def jev_enabled() -> bool:
    """Jev scoring can be disabled with JEV_ENABLED=0 to compare against
    LLM-only scoring. This switches off the Jev *questions*, not the transport —
    there is no env var that routes traffic around the gateway."""
    return (os.environ.get("JEV_ENABLED") or "").strip() != "0"
