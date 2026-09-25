import pytest

from agent.llm import MAX_RETRY_DELAY_SECONDS, with_retry


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
