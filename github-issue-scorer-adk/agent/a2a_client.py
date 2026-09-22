"""A minimal A2A client (over httpx) for calling a remote ADK agent.

We can't use ADK's own RemoteA2aAgent here: it targets a2a-sdk 0.3.x, but this
container has a2a-sdk 1.x (pulled by ag-ui-adk), and the two conflict. The A2A
wire protocol is small, so we speak it directly: fetch the agent card, then POST
a JSON-RPC `message/send` and pull the reply text out of the returned Task.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx

WELL_KNOWN = "/.well-known/agent-card.json"


def _extract_text(result: dict[str, Any]) -> str:
    """Pull the agent's text out of an A2A result (Task or Message)."""
    if not isinstance(result, dict):
        return ""
    chunks: list[str] = []

    def _collect(parts: Any) -> None:
        for p in parts or []:
            if isinstance(p, dict) and p.get("kind") == "text" and p.get("text"):
                chunks.append(p["text"])

    # Task: prefer artifacts, then the final status message.
    for art in result.get("artifacts") or []:
        _collect(art.get("parts"))
    if not chunks:
        _collect(((result.get("status") or {}).get("message") or {}).get("parts"))
    # Direct Message result.
    if not chunks:
        _collect(result.get("parts"))
    return "\n".join(chunks).strip()


async def request_plan(base_url: str, text: str, timeout: float = 90.0) -> str:
    """Send `text` to the remote A2A agent at `base_url` and return its reply.

    Raises on transport errors, a JSON-RPC error, or a failed task.
    """
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=timeout) as client:
        card = (await client.get(base + WELL_KNOWN)).raise_for_status().json()
        rpc_url = card.get("url") or base

        req = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": text}],
                    "messageId": str(uuid.uuid4()),
                    "kind": "message",
                }
            },
        }
        resp = (await client.post(rpc_url, json=req)).raise_for_status().json()

    if "error" in resp:
        raise RuntimeError(f"A2A error: {resp['error']}")
    result = resp.get("result") or {}

    # Surface a failed/errored task with its message rather than returning it as
    # a "plan". ADK reports upstream failures via an adk_error_code in metadata
    # (with the error text as the message) and doesn't always set state=failed.
    status_msg = (result.get("status") or {}).get("message") or {}
    err_code = (result.get("metadata") or {}).get("adk_error_code") or (
        status_msg.get("metadata") or {}
    ).get("adk_error_code")
    state = (result.get("status") or {}).get("state")
    reply = _extract_text(result)
    if err_code or state in ("failed", "errored"):
        raise RuntimeError(
            f"Planner failed ({err_code or state}): {reply[:300] or 'unknown error'}"
        )
    if not reply:
        raise RuntimeError("Planner returned no text.")
    return reply
