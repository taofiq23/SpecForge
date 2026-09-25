from typing import Optional

import pytest

from agent.tools import GREP_MAX_MATCHES, SandboxViolation, Workspace, make_tools


@pytest.fixture
def workspace(tmp_path):
    return Workspace(tmp_path / "project")


@pytest.fixture
def tools(workspace):
    return make_tools(workspace)


def test_write_then_read_round_trips(tools):
    result = tools.call("write_file", {"path": "src/app.py", "content": "print('hi')\n"})
    assert not result.is_error
    assert "Wrote" in result.content

    result = tools.call("read_file", {"path": "src/app.py"})
    assert not result.is_error
    assert "print('hi')" in result.content
    assert "    1\t" in result.content  # line numbers


def test_write_creates_parent_directories(tools, workspace):
    tools.call("write_file", {"path": "a/b/c/deep.txt", "content": "x"})
    assert (workspace.root / "a" / "b" / "c" / "deep.txt").exists()


def test_read_missing_file_is_a_reported_error_not_an_exception(tools):
    result = tools.call("read_file", {"path": "nope.txt"})
    assert result.is_error
    assert "No such file" in result.content


def test_path_traversal_outside_workspace_is_blocked(tools):
    result = tools.call("write_file", {"path": "../escape.txt", "content": "x"})
    assert result.is_error
    assert "outside the workspace" in result.content


def test_workspace_resolve_raises_directly_for_traversal(workspace):
    with pytest.raises(SandboxViolation):
        workspace.resolve("../../etc/passwd")


def test_edit_file_requires_unique_match(tools):
    tools.call("write_file", {"path": "f.txt", "content": "a\na\nb\n"})

    ambiguous = tools.call("edit_file", {"path": "f.txt", "old_text": "a", "new_text": "z"})
    assert ambiguous.is_error
    assert "matches 2 times" in ambiguous.content

    ok = tools.call("edit_file", {"path": "f.txt", "old_text": "b", "new_text": "z"})
    assert not ok.is_error
    assert tools.call("read_file", {"path": "f.txt"}).content.endswith("3\tz")


def test_edit_file_missing_old_text(tools):
    tools.call("write_file", {"path": "f.txt", "content": "hello\n"})
    result = tools.call("edit_file", {"path": "f.txt", "old_text": "goodbye", "new_text": "x"})
    assert result.is_error
    assert "not found" in result.content


def test_edit_file_rejects_identical_old_and_new_text(tools):
    tools.call("write_file", {"path": "f.txt", "content": "hello\n"})
    result = tools.call("edit_file", {"path": "f.txt", "old_text": "hello", "new_text": "hello"})
    assert result.is_error
    assert "identical" in result.content


def test_edit_file_replace_all_replaces_every_occurrence(tools):
    tools.call("write_file", {"path": "f.txt", "content": "a\na\nb\n"})
    result = tools.call("edit_file", {"path": "f.txt", "old_text": "a", "new_text": "z", "replace_all": True})
    assert not result.is_error
    assert "2 replacements" in result.content
    assert tools.call("read_file", {"path": "f.txt"}).content.count("\tz") == 2


def test_list_files_skips_noise_directories(tools, workspace):
    tools.call("write_file", {"path": "src/main.py", "content": "x"})
    tools.call("write_file", {"path": "node_modules/pkg/index.js", "content": "x"})
    tools.call("write_file", {"path": ".git/HEAD", "content": "x"})

    result = tools.call("list_files", {})
    assert "src/main.py" in result.content
    assert "node_modules" not in result.content
    assert ".git" not in result.content


def test_run_shell_reports_exit_code_and_output(tools):
    result = tools.call("run_shell", {"command": "python -c \"print('ok')\""})
    assert not result.is_error
    assert "ok" in result.content
    assert "(exit 0)" in result.content


def test_run_shell_nonzero_exit_is_flagged_as_error(tools):
    result = tools.call("run_shell", {"command": "python -c \"import sys; sys.exit(3)\""})
    assert result.is_error
    assert "(exit 3)" in result.content


def test_unknown_tool_reports_error_without_crashing(tools):
    result = tools.call("delete_everything", {})
    assert result.is_error
    assert "Unknown tool" in result.content


def test_grep_search_finds_matches_across_files_with_line_numbers(tools):
    tools.call("write_file", {"path": "a.py", "content": "def foo():\n    return 1\n"})
    tools.call("write_file", {"path": "b.py", "content": "def bar():\n    foo()\n"})

    result = tools.call("grep_search", {"pattern": r"\bfoo\b"})
    assert not result.is_error
    assert "a.py:1: def foo():" in result.content
    assert "b.py:2: foo()" in result.content


def test_grep_search_skips_unreadable_binary_files(tools, workspace):
    (workspace.root / "blob.bin").write_bytes(b"\xff\xfe\x00\x01binary")
    tools.call("write_file", {"path": "text.py", "content": "needle\n"})

    result = tools.call("grep_search", {"pattern": "needle"})
    assert not result.is_error
    assert "text.py:1: needle" in result.content


def test_grep_search_no_matches(tools):
    tools.call("write_file", {"path": "a.py", "content": "hello\n"})
    result = tools.call("grep_search", {"pattern": "nonexistent_token"})
    assert not result.is_error
    assert "no matches" in result.content


def test_grep_search_falls_back_to_literal_text_on_invalid_regex(tools):
    tools.call("write_file", {"path": "a.txt", "content": "price is $5 (final)\n"})
    result = tools.call("grep_search", {"pattern": "$5 (final"})  # unbalanced paren: invalid regex
    assert not result.is_error
    assert "literal text instead" in result.content
    assert "a.txt:1:" in result.content


def test_grep_search_reports_which_limit_truncated_results(tools):
    for i in range(GREP_MAX_MATCHES + 5):
        tools.call("write_file", {"path": f"f{i}.txt", "content": "needle\n"})
    result = tools.call("grep_search", {"pattern": "needle"})
    assert not result.is_error
    assert "number of results exceeded" in result.content


def test_grep_search_skips_secret_looking_files(tools):
    tools.call("write_file", {"path": ".env", "content": "API_KEY=needle\n"})
    tools.call("write_file", {"path": "app.py", "content": "# needle\n"})
    result = tools.call("grep_search", {"pattern": "needle"})
    assert ".env" not in result.content
    assert "app.py:1:" in result.content


def test_read_file_refuses_secret_looking_paths(tools):
    tools.call("write_file", {"path": ".env", "content": "SECRET=x\n"})
    result = tools.call("read_file", {"path": ".env"})
    assert result.is_error
    assert "secret" in result.content.lower()


def test_run_shell_wait_false_starts_in_background_and_returns_immediately(tools):
    result = tools.call("run_shell", {"command": "python -c \"import time; time.sleep(2)\"", "wait": False})
    assert not result.is_error
    assert "background" in result.content


def test_multi_edit_applies_dependent_edits_in_order(tools):
    tools.call("write_file", {"path": "f.txt", "content": "hello world\n"})
    result = tools.call(
        "multi_edit",
        {"path": "f.txt", "edits": [{"old_text": "hello", "new_text": "goodbye"}, {"old_text": "goodbye world", "new_text": "goodbye cruel world"}]},
    )
    assert not result.is_error
    assert "2 edit(s)" in result.content
    assert tools.call("read_file", {"path": "f.txt"}).content.endswith("goodbye cruel world")


def test_multi_edit_is_atomic_a_failing_edit_applies_none(tools):
    tools.call("write_file", {"path": "f.txt", "content": "hello world\n"})
    result = tools.call(
        "multi_edit",
        {"path": "f.txt", "edits": [{"old_text": "hello", "new_text": "goodbye"}, {"old_text": "not present anywhere", "new_text": "x"}]},
    )
    assert result.is_error
    assert "no edits were applied" in result.content.lower()
    # the first edit's effect must NOT have been written, since the whole call failed
    assert tools.call("read_file", {"path": "f.txt"}).content.endswith("hello world")


def test_multi_edit_respects_replace_all_per_edit(tools):
    tools.call("write_file", {"path": "f.txt", "content": "a a a\n"})
    result = tools.call("multi_edit", {"path": "f.txt", "edits": [{"old_text": "a", "new_text": "b", "replace_all": True}]})
    assert not result.is_error
    assert tools.call("read_file", {"path": "f.txt"}).content.endswith("b b b")


def test_multi_edit_requires_at_least_one_edit(tools):
    tools.call("write_file", {"path": "f.txt", "content": "x\n"})
    result = tools.call("multi_edit", {"path": "f.txt", "edits": []})
    assert result.is_error


# --- fetch_url --------------------------------------------------------------------------------
import io
import urllib.error

from agent.tools import _HTMLTextExtractor, _unsafe_host_reason


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",  # loopback
        "localhost",  # resolves to loopback
        "169.254.169.254",  # cloud metadata endpoint - the classic SSRF target
        "10.0.0.5",  # RFC 1918 private
        "172.16.0.1",  # RFC 1918 private
        "192.168.1.1",  # RFC 1918 private
        "0.0.0.0",  # unspecified
    ],
)
def test_unsafe_host_reason_blocks_internal_and_private_addresses(host):
    assert _unsafe_host_reason(host) is not None


def test_unsafe_host_reason_allows_a_real_public_address():
    # 8.8.8.8 is Google's public DNS - a real, stable, always-public IP, not a domain that could
    # resolve differently; used only to check our own logic classifies a public IP as public.
    assert _unsafe_host_reason("8.8.8.8") is None


def test_unsafe_host_reason_reports_unresolvable_hosts():
    reason = _unsafe_host_reason("this-domain-should-not-exist-ever.invalid")
    assert reason is not None and "resolve" in reason


def test_fetch_url_rejects_non_http_schemes(tools):
    for url in ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]:
        result = tools.call("fetch_url", {"url": url})
        assert result.is_error
        assert "scheme" in result.content.lower()


def test_fetch_url_refuses_private_and_loopback_targets(tools):
    for url in ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/"]:
        result = tools.call("fetch_url", {"url": url})
        assert result.is_error
        assert "refusing to fetch" in result.content.lower()


def test_html_text_extractor_strips_tags_and_script_style_content():
    extractor = _HTMLTextExtractor()
    extractor.feed("<html><head><style>.x{color:red}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>evil()</script></body></html>")
    text = extractor.text()
    assert "Title" in text and "Hello" in text and "world" in text
    assert "evil()" not in text and "color:red" not in text


class _FakeHTTPResponse:
    def __init__(self, body: bytes, content_type: str):
        self._body = body
        self.headers = {"Content-Type": content_type}

    def read(self, n: int) -> bytes:
        return self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeOpener:
    def __init__(self, response=None, http_error: Optional[urllib.error.HTTPError] = None):
        self._response, self._http_error = response, http_error

    def open(self, request, timeout):
        if self._http_error:
            raise self._http_error
        return self._response


def _patch_opener(monkeypatch, opener):
    """Patches the network layer only. Every caller here uses a *.example.com host purely as a
    plausible-looking URL for messages/assertions - it is not meant to be resolved, so the
    hostname-safety check (already covered by its own direct tests above) is bypassed rather than
    relied on to pass, since where *.example.com actually resolves depends on the network the
    tests run on (in this sandbox, real DNS resolves it into the IANA benchmark-testing range,
    198.18.0.0/15, which our SSRF guard correctly treats as non-public - discovered by these tests
    failing for the right reason on the first attempt)."""
    monkeypatch.setattr("agent.tools.urllib.request.build_opener", lambda *a, **k: opener)
    monkeypatch.setattr("agent.tools._unsafe_host_reason", lambda hostname: None)


def test_fetch_url_converts_html_to_text(monkeypatch):
    from agent.tools import _fetch_url

    html = b"<html><body><h1>Example Domain</h1><p>For use in examples.</p></body></html>"
    _patch_opener(monkeypatch, _FakeOpener(_FakeHTTPResponse(html, "text/html; charset=utf-8")))

    result = _fetch_url("https://example.com")
    assert not result.is_error
    assert "Example Domain" in result.content
    assert "<h1>" not in result.content


def test_fetch_url_passes_through_plain_text_and_json(monkeypatch):
    from agent.tools import _fetch_url

    _patch_opener(monkeypatch, _FakeOpener(_FakeHTTPResponse(b'{"ok": true}', "application/json")))
    result = _fetch_url("https://api.example.com/status")
    assert not result.is_error
    assert result.content == '{"ok": true}'


def test_fetch_url_refuses_binary_content_types(monkeypatch):
    from agent.tools import _fetch_url

    _patch_opener(monkeypatch, _FakeOpener(_FakeHTTPResponse(b"\x89PNG...", "image/png")))
    result = _fetch_url("https://example.com/logo.png")
    assert result.is_error
    assert "not text" in result.content.lower() or "binary" in result.content.lower()


def test_fetch_url_truncates_long_text_at_the_documented_limit(monkeypatch):
    from agent.tools import FETCH_TEXT_CHAR_LIMIT, _fetch_url

    long_text = ("word " * (FETCH_TEXT_CHAR_LIMIT)).encode()
    _patch_opener(monkeypatch, _FakeOpener(_FakeHTTPResponse(long_text, "text/plain")))
    result = _fetch_url("https://example.com/big")
    assert not result.is_error
    assert len(result.content) <= FETCH_TEXT_CHAR_LIMIT + len("\n...[truncated to N characters]") + 10
    assert "truncated" in result.content


def test_fetch_url_does_not_follow_redirects_automatically(monkeypatch):
    from agent.tools import _fetch_url

    error = urllib.error.HTTPError(url="https://example.com/old", code=302, msg="Found", hdrs={"Location": "https://example.com/new"}, fp=io.BytesIO())
    _patch_opener(monkeypatch, _FakeOpener(http_error=error))
    result = _fetch_url("https://example.com/old")
    assert result.is_error
    assert "redirects" in result.content.lower()
    assert "https://example.com/new" in result.content


def test_fetch_url_reports_http_errors_clearly(monkeypatch):
    from agent.tools import _fetch_url

    error = urllib.error.HTTPError(url="https://example.com/missing", code=404, msg="Not Found", hdrs={}, fp=io.BytesIO())
    _patch_opener(monkeypatch, _FakeOpener(http_error=error))
    result = _fetch_url("https://example.com/missing")
    assert result.is_error
    assert "404" in result.content
