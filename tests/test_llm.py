import types

import pytest

from agent.llm import MAX_RETRY_DELAY_SECONDS, AnthropicAdapter, OpenAICompatibleAdapter, with_retry


class RateLimitError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class _FakeHeaders(dict):
    def get(self, key, default=None):
        return dict.get(self, key, default)


class _FakeResponse:
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = _FakeHeaders(headers or {})


class ApiError(Exception):
    """Shaped like the real SDKs: a .response with .status_code and .headers."""

    def __init__(self, message, status_code, headers=None):
        super().__init__(message)
        self.response = _FakeResponse(status_code, headers)


def test_with_retry_succeeds_on_first_try_without_sleeping(monkeypatch):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: pytest.fail("should not sleep"))
    assert with_retry(lambda: 42) == 42


def test_with_retry_retries_transient_errors_and_eventually_succeeds(monkeypatch):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RateLimitError("429")
        return "ok"

    assert with_retry(flaky, max_retries=3) == "ok"
    assert calls["n"] == 3


def test_with_retry_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: None)

    def always_fails():
        raise RateLimitError("still 429")

    with pytest.raises(RateLimitError):
        with_retry(always_fails, max_retries=2)


def test_with_retry_does_not_retry_non_transient_errors(monkeypatch):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: pytest.fail("should not sleep/retry"))
    calls = {"n": 0}

    def bad_key():
        calls["n"] += 1
        raise AuthenticationError("invalid api key")

    with pytest.raises(AuthenticationError):
        with_retry(bad_key)
    assert calls["n"] == 1


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504, 529])
def test_with_retry_treats_every_documented_status_code_as_transient(monkeypatch, status):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ApiError("server trouble", status_code=status)
        return "recovered"

    assert with_retry(flaky) == "recovered"


def test_with_retry_does_not_retry_other_4xx_status_codes(monkeypatch):
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: pytest.fail("should not retry a 404"))

    def not_found():
        raise ApiError("no such model", status_code=404)

    with pytest.raises(ApiError):
        with_retry(not_found)


def test_with_retry_catches_overloaded_by_message_when_no_status_code(monkeypatch):
    """Anthropic's 529 is in the status-code list above, but some SDKs surface capacity errors as
    a plain exception with no status code at all - falling back to the message text is what
    catches those (a real gap Continue's own status-code-first list would otherwise miss)."""
    monkeypatch.setattr("agent.llm.time.sleep", lambda s: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("Overloaded: the model is temporarily overloaded")
        return "ok"

    assert with_retry(flaky) == "ok"


def test_with_retry_respects_retry_after_header_instead_of_guessing(monkeypatch):
    sleeps = []
    monkeypatch.setattr("agent.llm.time.sleep", sleeps.append)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ApiError("rate limited", status_code=429, headers={"retry-after": "5"})
        return "ok"

    assert with_retry(flaky) == "ok"
    assert sleeps == [5.0]  # the header's value, not an exponential-backoff guess


def test_with_retry_caps_retry_after_at_max_delay(monkeypatch):
    sleeps = []
    monkeypatch.setattr("agent.llm.time.sleep", sleeps.append)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ApiError("rate limited", status_code=429, headers={"retry-after": "9999"})
        return "ok"

    with_retry(flaky)
    assert sleeps == [MAX_RETRY_DELAY_SECONDS]


def test_with_retry_exponential_backoff_has_jitter_and_respects_the_cap(monkeypatch):
    sleeps = []
    monkeypatch.setattr("agent.llm.time.sleep", sleeps.append)
    calls = {"n": 0}

    def always_fails_until_the_end():
        calls["n"] += 1
        raise RateLimitError("429")

    with pytest.raises(RateLimitError):
        with_retry(always_fails_until_the_end, max_retries=5)

    assert len(sleeps) == 5
    # base delay 1.0 -> exponential 1,2,4,8,16 - each within +-30% jitter, all under the cap
    for delay, base in zip(sleeps, [1, 2, 4, 8, 16]):
        assert 0 <= delay <= min(base, MAX_RETRY_DELAY_SECONDS) * 1.31
    assert len(set(sleeps)) > 1  # jitter means they're not all identical


# --- AnthropicAdapter streaming: mocks the SDK's stream() context manager, no network. ---
# These adapters had zero direct test coverage before streaming was added (only with_retry was
# tested) - streaming is genuinely new logic (especially OpenAI's fragmented tool-call JSON
# accumulation below), so it gets real tests, not just "the existing suite still passes".


class _FakeAnthropicStream:
    def __init__(self, text_chunks, final_message):
        self._text_chunks = text_chunks
        self._final_message = final_message

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    @property
    def text_stream(self):
        return iter(self._text_chunks)

    def get_final_message(self):
        return self._final_message


class _FakeAnthropicClient:
    def __init__(self, stream_obj):
        self.messages = types.SimpleNamespace(stream=lambda **kwargs: stream_obj)


def test_anthropic_adapter_streams_text_deltas_and_returns_the_final_assembled_message():
    final_message = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text="Hello world")],
        stop_reason="end_turn",
        usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
    )
    adapter = AnthropicAdapter(model="claude-x", api_key="fake-key-for-test")
    adapter._client = _FakeAnthropicClient(_FakeAnthropicStream(["Hello ", "world"], final_message))

    seen = []
    response = adapter.complete("sys", [{"role": "user", "content": "hi"}], [], on_text_delta=seen.append)

    assert seen == ["Hello ", "world"]  # narrated live, as it "arrived"
    assert response.text == "Hello world"  # the final response comes from get_final_message(), not the deltas
    assert response.stop_reason == "end_turn"
    assert response.usage == {"input_tokens": 10, "output_tokens": 5}


def test_anthropic_adapter_assembles_tool_use_blocks_from_the_final_message():
    final_message = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="tool_use", id="call_1", name="write_file", input={"path": "a.txt"})],
        stop_reason="tool_use",
        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
    )
    adapter = AnthropicAdapter(model="claude-x", api_key="fake-key-for-test")
    adapter._client = _FakeAnthropicClient(_FakeAnthropicStream([], final_message))

    response = adapter.complete("sys", [], [])

    assert response.tool_calls == [{"type": "tool_use", "id": "call_1", "name": "write_file", "input": {"path": "a.txt"}}]
    assert response.stop_reason == "tool_use"


def test_anthropic_adapter_works_with_no_delta_callback_at_all():
    final_message = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text="fine")],
        stop_reason="end_turn",
        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
    )
    adapter = AnthropicAdapter(model="claude-x", api_key="fake-key-for-test")
    adapter._client = _FakeAnthropicClient(_FakeAnthropicStream(["fine"], final_message))

    response = adapter.complete("sys", [], [])  # on_text_delta omitted entirely

    assert response.text == "fine"


# --- OpenAICompatibleAdapter streaming: no get_final_message() helper here, so tool-call JSON
# arguments are accumulated by hand across fragmented chunks - the part most likely to have a
# subtle bug, so it gets the most direct coverage. ---


def _chunk(content=None, tool_call_deltas=None, usage=None):
    delta = types.SimpleNamespace(content=content, tool_calls=tool_call_deltas)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta)], usage=usage)


def _tc_delta(index, id=None, name=None, arguments=None):
    has_function = name is not None or arguments is not None
    function = types.SimpleNamespace(name=name, arguments=arguments) if has_function else None
    return types.SimpleNamespace(index=index, id=id, function=function)


class _FakeOpenAIClient:
    def __init__(self, chunks):
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=lambda **kwargs: iter(chunks)))


def test_openai_adapter_streams_text_and_reads_usage_from_the_final_chunk(monkeypatch):
    monkeypatch.setenv("FAKE_OPENAI_KEY_1", "fake-key")
    chunks = [
        _chunk(content="Hello "),
        _chunk(content="world"),
        _chunk(usage=types.SimpleNamespace(prompt_tokens=20, completion_tokens=3)),
    ]
    adapter = OpenAICompatibleAdapter(model="x", base_url="https://fake", api_key_env="FAKE_OPENAI_KEY_1")
    adapter._client = _FakeOpenAIClient(chunks)

    seen = []
    response = adapter.complete("sys", [{"role": "user", "content": "hi"}], [], on_text_delta=seen.append)

    assert seen == ["Hello ", "world"]
    assert response.text == "Hello world"
    assert response.usage == {"input_tokens": 20, "output_tokens": 3}
    assert response.stop_reason == "end_turn"


def test_openai_adapter_accumulates_a_tool_calls_json_arguments_across_fragmented_chunks(monkeypatch):
    # Real risk this guards against: OpenAI's streaming API sends function.arguments as partial
    # JSON string fragments over several chunks, keyed by tool-call index - concatenate them
    # incorrectly (or parse too early) and the tool call's input silently corrupts.
    monkeypatch.setenv("FAKE_OPENAI_KEY_2", "fake-key")
    chunks = [
        _chunk(tool_call_deltas=[_tc_delta(0, id="call_1", name="write_file", arguments='{"path"')]),
        _chunk(tool_call_deltas=[_tc_delta(0, arguments=': "a.txt", ')]),
        _chunk(tool_call_deltas=[_tc_delta(0, arguments='"content": "hi"}')]),
        _chunk(usage=types.SimpleNamespace(prompt_tokens=5, completion_tokens=5)),
    ]
    adapter = OpenAICompatibleAdapter(model="x", base_url="https://fake", api_key_env="FAKE_OPENAI_KEY_2")
    adapter._client = _FakeOpenAIClient(chunks)

    response = adapter.complete("sys", [], [])

    assert response.tool_calls == [
        {"type": "tool_use", "id": "call_1", "name": "write_file", "input": {"path": "a.txt", "content": "hi"}}
    ]
    assert response.stop_reason == "tool_use"


def test_openai_adapter_accumulates_two_parallel_tool_calls_by_index(monkeypatch):
    monkeypatch.setenv("FAKE_OPENAI_KEY_3", "fake-key")
    chunks = [
        _chunk(tool_call_deltas=[_tc_delta(0, id="call_1", name="read_file", arguments='{"path": "a"}')]),
        _chunk(tool_call_deltas=[_tc_delta(1, id="call_2", name="read_file", arguments='{"path": "b"}')]),
        _chunk(usage=types.SimpleNamespace(prompt_tokens=1, completion_tokens=1)),
    ]
    adapter = OpenAICompatibleAdapter(model="x", base_url="https://fake", api_key_env="FAKE_OPENAI_KEY_3")
    adapter._client = _FakeOpenAIClient(chunks)

    response = adapter.complete("sys", [], [])

    assert response.tool_calls == [
        {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a"}},
        {"type": "tool_use", "id": "call_2", "name": "read_file", "input": {"path": "b"}},
    ]
