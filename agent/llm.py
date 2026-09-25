"""The pluggable "brain" behind the agent loop.

Everything above this file (the loop, the tools, the planner) talks to the model through one
neutral wire format - the same shape Anthropic's Messages API uses for tool calls, since it is
the clearest way to represent "the model asked to use a tool" and "here is the tool's result" as
plain data:

    assistant turn:  {"role": "assistant", "content": [
                          {"type": "text", "text": "..."},
                          {"type": "tool_use", "id": "call_1", "name": "write_file", "input": {...}}
                      ]}
    tool result:      {"role": "user", "content": [
                          {"type": "tool_result", "tool_use_id": "call_1", "content": "...", "is_error": False}
                      ]}

Swapping which model answers is then a one-class change: implement `LLMAdapter.complete()` for a
new provider, translating this neutral format to and from that provider's wire format at the
boundary. Nothing else in the agent needs to know which provider is behind it.
"""

from __future__ import annotations

import os
import random
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, List, Optional, TypeVar

T = TypeVar("T")

# Ported from Continue's core/llm/utils/retry.ts (Apache-2.0), adapted to Python and to calling a
# plain function instead of decorating an async method. Kept: retrying on 429/5xx/network/timeout
# errors but never on other 4xx, exponential backoff with jitter so many clients retrying the same
# rate limit don't all collide again at once, a delay cap, and - the part a naive exponential
# backoff misses - actually reading the API's Retry-After header when it sends one, instead of
# guessing. Two gaps in Continue's own status-code list were added after checking Anthropic's
# actual API docs: 529 ("Overloaded") isn't in the standard 5xx-retry range their code checks, and
# neither is the word "overloaded" that both Anthropic and OpenAI-compatible APIs use in the
# message body for capacity errors that don't always carry a matching status code.
MAX_RETRIES = 3
BASE_RETRY_DELAY_SECONDS = 1.0
MAX_RETRY_DELAY_SECONDS = 30.0
JITTER_FACTOR = 0.3
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504, 529}
RETRYABLE_MESSAGE_SUBSTRINGS = ("overloaded", "timeout", "timed out")


def _status_code(error: Exception) -> Optional[int]:
    for attr in ("status_code", "status"):
        value = getattr(error, attr, None)
        if value is not None:
            return value
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None) if response is not None else None


def _is_transient(error: Exception) -> bool:
    status = _status_code(error)
    if status is not None:
        return status in RETRYABLE_STATUS_CODES  # explicitly excludes other 4xx - a bad request or key won't fix itself
    name = type(error).__name__
    if any(token in name for token in ("RateLimit", "APIConnection", "APITimeout", "InternalServerError", "ServiceUnavailable")):
        return True
    message = str(error).lower()
    return any(s in message for s in RETRYABLE_MESSAGE_SUBSTRINGS)


def _retry_after_seconds(error: Exception) -> Optional[float]:
    """The API's own Retry-After header, when it sends one - more accurate than guessing via
    exponential backoff, exactly as Continue's calculateDelay() prefers it."""
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None) if response is not None else None
    if not headers:
        return None
    for key in ("retry-after", "x-ratelimit-reset", "ratelimit-reset"):
        raw = headers.get(key)
        if not raw:
            continue
        if raw.isdigit():
            return float(raw)
        try:
            return max(0.0, (parsedate_to_datetime(raw) - _now_utc()).total_seconds())
        except (TypeError, ValueError):
            continue
    return None


def _now_utc():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


def _delay_for_attempt(attempt: int, error: Exception) -> float:
    server_delay = _retry_after_seconds(error)
    if server_delay is not None:
        return min(server_delay, MAX_RETRY_DELAY_SECONDS)
    exponential = min(BASE_RETRY_DELAY_SECONDS * (2**attempt), MAX_RETRY_DELAY_SECONDS)
    jitter = 1 + random.uniform(-JITTER_FACTOR, JITTER_FACTOR)
    return max(0.0, exponential * jitter)


def with_retry(call: Callable[[], T], max_retries: int = MAX_RETRIES) -> T:
    for attempt in range(max_retries + 1):
        try:
            return call()
        except Exception as e:
            if attempt == max_retries or not _is_transient(e):
                raise
            time.sleep(_delay_for_attempt(attempt, e))
    raise AssertionError("unreachable")  # the loop above always returns or raises


@dataclass
class ToolSpec:
    """One tool's definition, in the shape the model needs to decide when to call it.

    `read_only` is our own bookkeeping (logged, not sent to the model) - it doesn't gate anything
    here, but it documents which tools could safely be auto-allowed under a real permission system
    like Claude Code's, versus which ones (edits, shell) actually change the project."""

    name: str
    description: str
    input_schema: Dict[str, Any]
    read_only: bool = False

    def to_anthropic(self) -> Dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}

    def to_openai(self) -> Dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.input_schema}}


@dataclass
class LLMResponse:
    """One model turn, as a list of neutral content blocks (the same shape as an incoming
    message's `content`) so the loop can append `{"role": "assistant", "content": response.content}`
    straight back into the conversation, unchanged, regardless of which provider answered."""

    content: List[Dict[str, Any]]
    stop_reason: str  # "tool_use" | "end_turn" | "max_tokens" | "error"
    usage: Dict[str, int] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return "".join(b["text"] for b in self.content if b.get("type") == "text")

    @property
    def tool_calls(self) -> List[Dict[str, Any]]:
        return [b for b in self.content if b.get("type") == "tool_use"]


class LLMAdapter(ABC):
    """Implement this once per model provider. The agent loop only ever calls `complete()`."""

    @abstractmethod
    def complete(self, system: str, messages: List[Dict[str, Any]], tools: List[ToolSpec]) -> LLMResponse:
        """One round-trip: system prompt + conversation-so-far + available tools -> one model turn."""


class AnthropicAdapter(LLMAdapter):
    """Talks to Claude via the standard Messages API. Needs ANTHROPIC_API_KEY in the environment
    (a console API key, or - for Claude Pro/Max subscribers - the token from `claude setup-token`,
    which the Anthropic SDK also accepts as ANTHROPIC_API_KEY for Agent-SDK-style usage)."""

    def __init__(self, model: str = "claude-sonnet-5", max_tokens: int = 8192, api_key: Optional[str] = None):
        try:
            import anthropic
        except ImportError as e:
            raise RuntimeError("pip install anthropic to use AnthropicAdapter") from e
        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("Set ANTHROPIC_API_KEY (see README for how to get one from your Claude plan or the console).")
        self._client = anthropic.Anthropic(api_key=key)
        self._model = model
        self._max_tokens = max_tokens

    def complete(self, system: str, messages: List[Dict[str, Any]], tools: List[ToolSpec]) -> LLMResponse:
        response = with_retry(
            lambda: self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=system,
                messages=messages,
                tools=[t.to_anthropic() for t in tools] if tools else [],
            )
        )
        content = []
        for block in response.content:
            if block.type == "text":
                content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
        return LLMResponse(
            content=content,
            stop_reason=response.stop_reason,
            usage={"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens},
        )


class OpenAICompatibleAdapter(LLMAdapter):
    """Talks to any OpenAI-compatible chat-completions endpoint with function calling - this
    covers DeepSeek, OpenAI itself, and most open-weight model hosts (Groq, together.ai, a local
    Ollama/vLLM server), since they all implement the same wire format. Only the base_url, the
    API key's env var, and the model name change between them.
    """

    def __init__(self, model: str, base_url: str, api_key_env: str):
        try:
            import openai
        except ImportError as e:
            raise RuntimeError("pip install openai to use OpenAICompatibleAdapter (it works for DeepSeek too)") from e
        key = os.environ.get(api_key_env)
        if not key:
            raise RuntimeError(f"Set {api_key_env} in the environment.")
        self._client = openai.OpenAI(api_key=key, base_url=base_url)
        self._model = model

    @classmethod
    def deepseek(cls, model: str = "deepseek-chat") -> "OpenAICompatibleAdapter":
        return cls(model=model, base_url="https://api.deepseek.com", api_key_env="DEEPSEEK_API_KEY")

    def _to_openai_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Translate our Anthropic-shaped neutral messages into OpenAI's flatter shape, where
        tool calls and tool results are their own message roles instead of content blocks."""
        out: List[Dict[str, Any]] = []
        for msg in messages:
            content = msg["content"]
            if isinstance(content, str):
                out.append({"role": msg["role"], "content": content})
                continue
            text_parts = [b["text"] for b in content if b.get("type") == "text"]
            tool_uses = [b for b in content if b.get("type") == "tool_use"]
            tool_results = [b for b in content if b.get("type") == "tool_result"]
            if msg["role"] == "assistant":
                entry: Dict[str, Any] = {"role": "assistant", "content": "\n".join(text_parts) or None}
                if tool_uses:
                    entry["tool_calls"] = [
                        {"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": _json_dumps(t["input"])}}
                        for t in tool_uses
                    ]
                out.append(entry)
            else:
                if text_parts:
                    out.append({"role": "user", "content": "\n".join(text_parts)})
                for r in tool_results:
                    out.append({"role": "tool", "tool_call_id": r["tool_use_id"], "content": str(r["content"])})
        return out

    def complete(self, system: str, messages: List[Dict[str, Any]], tools: List[ToolSpec]) -> LLMResponse:
        openai_messages = [{"role": "system", "content": system}] + self._to_openai_messages(messages)
        response = with_retry(
            lambda: self._client.chat.completions.create(
                model=self._model,
                messages=openai_messages,
                tools=[t.to_openai() for t in tools] if tools else None,
            )
        )
        choice = response.choices[0]
        content: List[Dict[str, Any]] = []
        if choice.message.content:
            content.append({"type": "text", "text": choice.message.content})
        for tc in choice.message.tool_calls or []:
            content.append({"type": "tool_use", "id": tc.id, "name": tc.function.name, "input": _json_loads(tc.function.arguments)})
        stop_reason = "tool_use" if choice.message.tool_calls else "end_turn"
        usage = {"input_tokens": response.usage.prompt_tokens, "output_tokens": response.usage.completion_tokens} if response.usage else {}
        return LLMResponse(content=content, stop_reason=stop_reason, usage=usage)


def _json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj)


def _json_loads(text: str) -> Dict[str, Any]:
    import json

    return json.loads(text) if text else {}


def build_adapter(provider: str) -> LLMAdapter:
    """The one place that knows which adapter a provider name maps to - swap the AI brain by
    changing SPECFORGE_PROVIDER, not by editing the loop."""
    provider = provider.lower()
    if provider == "anthropic":
        return AnthropicAdapter(model=os.environ.get("SPECFORGE_MODEL", "claude-sonnet-5"))
    if provider == "deepseek":
        return OpenAICompatibleAdapter.deepseek(model=os.environ.get("SPECFORGE_MODEL", "deepseek-chat"))
    if provider == "openai":
        return OpenAICompatibleAdapter(model=os.environ.get("SPECFORGE_MODEL", "gpt-5"), base_url="https://api.openai.com/v1", api_key_env="OPENAI_API_KEY")
    raise ValueError(f"Unknown provider '{provider}'. Supported: anthropic, deepseek, openai.")
