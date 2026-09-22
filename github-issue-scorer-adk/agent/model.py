"""Model wiring: route ADK through the Postman Fabric Gateway.

The gateway exposes an OpenAI-compatible route, so we use LiteLlm with the
`openai/` provider prefix and forward the gateway's base URL, a placeholder key
(the gateway brokers the real upstream credential) and the gateway key header.
ADK's LiteLlm passes unknown kwargs — api_base, api_key, extra_headers —
straight through to litellm.acompletion.
"""

from __future__ import annotations

from google.adk.models.lite_llm import LiteLlm

from . import gateway


def build_model() -> LiteLlm:
    """The LlmAgent's model: the prose model via the Fabric Gateway."""
    return LiteLlm(
        model=f"openai/{gateway.PROSE_MODEL}",
        api_base=gateway.openai_base_url(),
        api_key=gateway.BROKERED_BY_GATEWAY,
        extra_headers=gateway.gateway_headers(),
    )
