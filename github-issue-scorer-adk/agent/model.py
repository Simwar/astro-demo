"""Model wiring: route ADK through the Astro AI gateway (OpenAI-compatible).

`astro_ai_gateway: true` in astropods.yml injects ASTRO_GATEWAY_URL and
ASTRO_GATEWAY_API_KEY. The gateway is a LiteLLM proxy exposing an OpenAI-style
API, so we use LiteLlm with the `openai/` provider prefix and forward the base
URL + key. ADK's LiteLlm passes unknown kwargs (api_base, api_key) straight
through to litellm.acompletion.
"""

from __future__ import annotations

import os

from google.adk.models.lite_llm import LiteLlm

# Model id as exposed by the gateway's whitelist.
GATEWAY_MODEL = os.environ.get("GATEWAY_MODEL", "claude-sonnet-4-6")


def gateway_base_url() -> str:
    """ASTRO_GATEWAY_URL is injected as the bare gateway root; LiteLLM's openai
    provider posts to {base}/chat/completions, and the proxy serves that under
    /v1 — so ensure the /v1 suffix. Defensive: safe whether or not it's present.
    """
    base = os.environ["ASTRO_GATEWAY_URL"].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base


def build_model() -> LiteLlm:
    """The LlmAgent's model — Claude via the Astro gateway."""
    return LiteLlm(
        model=f"openai/{GATEWAY_MODEL}",
        api_base=gateway_base_url(),
        api_key=os.environ["ASTRO_GATEWAY_API_KEY"],
    )
