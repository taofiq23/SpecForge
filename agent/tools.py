"""The agent's tool registry: everything the model is allowed to actually *do*.

Kept deliberately small, per the "essential components" reading of how Claude Code is built - six
tools cover file operations, search, editing and shell execution, which is enough for a code-
generation agent. Every tool is sandboxed to one workspace directory (the same "restrict to the
project directory" idea Claude Code uses in its own permission layer) so a model mistake can't
touch anything outside the project it's building.

Several pieces here are adapted, with attribution, from Continue (continuedev/continue,
Apache-2.0), an existing open-source coding agent, after reading its actual tool implementations
(not just its prompt text) - each is marked below with which real gap it closes and which file it
came from:

  - explicit read-before-edit / whitespace-preservation / no-parallel-same-file-edit guidance
    in the tool descriptions (core/tools/definitions/*.ts)
  - PowerShell on Windows / login shell on POSIX for run_shell, instead of Python's shell=True
    default (cmd.exe on Windows, /bin/sh - not a login shell - on POSIX), so PATH changes from
    .bashrc/.zshrc and richer scripting actually apply (core/tools/implementations/runTerminalCommand.ts)
  - a UTF-8-with-GBK-fallback decode for that shell's output, since a plain UTF-8 decode mangles
    non-ASCII output on Windows consoles using a legacy code page (same file)
  - grep_search falling back to a literal-text search (with a warning) instead of just erroring
    when the model's "pattern" isn't valid regex, and reporting *which* limit truncated a result
    set (match count vs. character count) (core/tools/implementations/grepSearch.ts)
  - refusing to read likely-secret files (.env, private keys, credential files) even inside the
    sandbox, in case a real one ever ends up in the generated project
    (core/tools/implementations/readFile.ts's throwIfFileIsSecurityConcern)
  - fetch_url's 20,000-character truncation limit and its "don't use this for files" guidance
    (core/tools/implementations/fetchUrlContent.ts's DEFAULT_FETCH_URL_CHAR_LIMIT and its
    definition file) - but NOT fetch_url's actual fetching/security logic below, which Continue
    delegates to a URLContextProvider module that wasn't in the source shared for this project;
    that part (the SSRF guard, redirect handling, HTML-to-text conversion) is written here from
    scratch and is called out as such, not claimed as adapted from something we didn't actually see.
"""

from __future__ import annotations

import ipaddress
import os
import platform
import re
import socket
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

from .llm import ToolSpec

MAX_RESULT_CHARS = 50_000  # mirrors the "truncate large tool output" lesson from the research
SHELL_TIMEOUT_SECONDS = 30
GREP_MAX_MATCHES = 200
GREP_MAX_CHARS = 8_000
FETCH_TIMEOUT_SECONDS = 10
FETCH_MAX_BYTES = 2_000_000
FETCH_TEXT_CHAR_LIMIT = 20_000  # matches Continue's DEFAULT_FETCH_URL_CHAR_LIMIT

NO_PARALLEL_EDIT_NOTE = "Do not call this tool twice for the same file in one turn - the second call's old_text is matched against the file as it was before the first call ran, not after."

SECRET_PATH_PATTERNS = [re.compile(p, re.IGNORECASE) for p in [r"(^|[\\/])\.env(\..*)?$", r"\.pem$", r"(^|[\\/])id_rsa$", r"credentials\.json$", r"\.key$"]]


def _is_secret_path(rel_posix_path: str) -> bool:
    return any(p.search(rel_posix_path) for p in SECRET_PATH_PATTERNS)


class SandboxViolation(Exception):
    """Raised when a tool call tries to touch a path outside the workspace."""


@dataclass
class ToolResult:
    content: str
    is_error: bool = False


class Workspace:
    """Resolves every path a tool is given against one root, and refuses anything that would
    escape it (via `..`, an absolute path elsewhere, or a symlink) - the sandboxing lesson from
    the permission-system research, reduced to the one rule that actually matters here."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, relative_path: str) -> Path:
        candidate = (self.root / relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError:
            raise SandboxViolation(f"'{relative_path}' resolves outside the workspace ({self.root})")
        return candidate


def _truncate(text: str) -> str:
    if len(text) <= MAX_RESULT_CHARS:
        return text
    return text[:MAX_RESULT_CHARS] + f"\n...[truncated, {len(text) - MAX_RESULT_CHARS} more characters]"


def _shell_description() -> str:
    system = platform.system()
    shell = "PowerShell" if system == "Windows" else f"your login shell ({os.environ.get('SHELL', '/bin/bash')})"
    return (
        f"Run a shell command inside the project root (e.g. to install dependencies or run tests). "
        f"This machine is {system}; commands run through {shell}, so prefer commands that work there "
        f"(e.g. on Windows, 'Remove-Item' not 'rm', 'Test-Path' not 'test -e'). "
        f"The shell is not stateful between calls - each call starts fresh, so 'cd x' does not persist. "
        f"Do not use this to edit files (no sed/awk) - use write_file or edit_file instead. "
        f"Times out after {SHELL_TIMEOUT_SECONDS}s; set wait=false to start something long-running "
        f"(e.g. a dev server) in the background instead of waiting for it to exit."
    )


def make_tools(workspace: Workspace) -> "ToolRegistry":
    registry = ToolRegistry()

    registry.register(
        ToolSpec(
            name="write_file",
            description=(
                "Create a new file, or completely overwrite an existing one, at a path relative to the "
                "project root. Creates parent directories as needed. Write the raw file content only - "
                "do not wrap it in a markdown code fence. Use edit_file instead for a small change to a "
                "file that already has content you want to keep."
            ),
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        ),
        lambda input: _write_file(workspace, input["path"], input["content"]),
    )

    registry.register(
        ToolSpec(
            name="read_file",
            description="Read a file's contents, with line numbers, from a path relative to the project root. Read a file before editing it, since the project may have changed since you last wrote it.",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            read_only=True,
        ),
        lambda input: _read_file(workspace, input["path"]),
    )

    registry.register(
        ToolSpec(
            name="edit_file",
            description=(
                "Replace text in an existing file by exact match. By default replaces exactly one "
                "occurrence of `old_text`, and fails if it matches zero or more than one place in the "
                "file - include enough surrounding lines in `old_text` to make it unique, and preserve "
                "the file's exact whitespace/indentation. Set `replace_all` to true to replace every "
                "occurrence instead (e.g. renaming an identifier throughout the file). "
                f"{NO_PARALLEL_EDIT_NOTE} Use write_file instead to replace a whole file's content."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                    "replace_all": {"type": "boolean", "description": "Replace every occurrence instead of requiring exactly one. Default false."},
                },
                "required": ["path", "old_text", "new_text"],
            },
        ),
        lambda input: _edit_file(workspace, input["path"], input["old_text"], input["new_text"], input.get("replace_all", False)),
    )

    registry.register(
        ToolSpec(
            name="multi_edit",
            description=(
                "Apply several find-and-replace edits to ONE file, in order, as a single atomic "
                "operation - each edit is matched against the file as it stands after the previous "
                "edits in this same call, so it correctly handles edits that depend on each other. "
                "Use this instead of calling edit_file more than once for the same file in one turn "
                "(edit_file's own description explains why that's unsafe). "
                "If any edit fails to match, none of the edits are applied."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_text": {"type": "string"},
                                "new_text": {"type": "string"},
                                "replace_all": {"type": "boolean"},
                            },
                            "required": ["old_text", "new_text"],
                        },
                    },
                },
                "required": ["path", "edits"],
            },
        ),
        lambda input: _multi_edit(workspace, input["path"], input["edits"]),
    )

    registry.register(
        ToolSpec(
            name="list_files",
            description="List files under a directory relative to the project root (recursive), skipping node_modules, .git and __pycache__.",
            input_schema={"type": "object", "properties": {"path": {"type": "string", "description": "Defaults to the project root."}}},
            read_only=True,
        ),
        lambda input: _list_files(workspace, input.get("path", ".")),
    )

    registry.register(
        ToolSpec(
            name="grep_search",
            description=(
                f"Search file contents under the project root for a regular expression pattern. "
                f"Returns at most {GREP_MAX_MATCHES} matches as 'path:line: text'. Use this instead of "
                "run_shell for finding where something is defined or used across the files you've written."
            ),
            input_schema={
                "type": "object",
                "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "description": "Directory to search under; defaults to the project root."}},
                "required": ["pattern"],
            },
            read_only=True,
        ),
        lambda input: _grep_search(workspace, input["pattern"], input.get("path", ".")),
    )

    registry.register(
        ToolSpec(
            name="fetch_url",
            description=(
                "Fetch the text content of a web page or API endpoint by URL (http/https only) - "
                "e.g. to check a library's current documentation before using it. Converts HTML to "
                "plain text. Do NOT use this for files in the project - use read_file for those. "
                "Refuses localhost, private-network and link-local addresses. Does not follow "
                "redirects automatically; if told a URL redirected, fetch the new location yourself "
                f"if you still want it. Content is truncated at {FETCH_TEXT_CHAR_LIMIT} characters."
            ),
            input_schema={"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
            read_only=True,
        ),
        lambda input: _fetch_url(input["url"]),
    )

    registry.register(
        ToolSpec(
            name="run_shell",
            description=_shell_description(),
            input_schema={
                "type": "object",
                "properties": {"command": {"type": "string"}, "wait": {"type": "boolean", "description": "Wait for the command to finish (default true). Set false for a long-running process."}},
                "required": ["command"],
            },
        ),
        lambda input: _run_shell(workspace, input["command"], input.get("wait", True)),
    )

    return registry


class ToolRegistry:
    def __init__(self) -> None:
        self._specs: Dict[str, ToolSpec] = {}
        self._handlers: Dict[str, Callable[[Dict[str, Any]], ToolResult]] = {}

    def register(self, spec: ToolSpec, handler: Callable[[Dict[str, Any]], ToolResult]) -> None:
        self._specs[spec.name] = spec
        self._handlers[spec.name] = handler

    @property
    def specs(self) -> List[ToolSpec]:
        return list(self._specs.values())

    def call(self, name: str, input: Dict[str, Any]) -> ToolResult:
        if name not in self._handlers:
            return ToolResult(content=f"Unknown tool '{name}'. Available: {', '.join(self._specs)}", is_error=True)
        try:
            return self._handlers[name](input)
        except SandboxViolation as e:
            return ToolResult(content=str(e), is_error=True)
        except Exception as e:  # a tool failing should be reported to the model, not crash the loop
            return ToolResult(content=f"{type(e).__name__}: {e}", is_error=True)


def _write_file(workspace: Workspace, path: str, content: str) -> ToolResult:
    target = workspace.resolve(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return ToolResult(content=f"Wrote {len(content)} bytes to {path}")


def _read_file(workspace: Workspace, path: str) -> ToolResult:
    target = workspace.resolve(path)
    if _is_secret_path(target.relative_to(workspace.root).as_posix()):
        return ToolResult(content=f"Refusing to read '{path}': it looks like a secret/credential file, not project source.", is_error=True)
    if not target.exists():
        return ToolResult(content=f"No such file: {path}", is_error=True)
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    numbered = "\n".join(f"{i + 1:>5}\t{line}" for i, line in enumerate(lines))
    return ToolResult(content=_truncate(numbered))


def _edit_file(workspace: Workspace, path: str, old_text: str, new_text: str, replace_all: bool = False) -> ToolResult:
    target = workspace.resolve(path)
    if not target.exists():
        return ToolResult(content=f"No such file: {path}", is_error=True)
    if old_text == new_text:
        return ToolResult(content="old_text and new_text are identical - nothing to do.", is_error=True)
    original = target.read_text(encoding="utf-8")
    count = original.count(old_text)
    if count == 0:
        return ToolResult(content="old_text not found in file - it must match exactly, including whitespace.", is_error=True)
    if count > 1 and not replace_all:
        return ToolResult(content=f"old_text matches {count} times - include more context to make it unique, or pass replace_all=true.", is_error=True)
    n = count if replace_all else 1
    target.write_text(original.replace(old_text, new_text, n), encoding="utf-8")
    return ToolResult(content=f"Edited {path} ({n} replacement{'s' if n != 1 else ''})")


def _multi_edit(workspace: Workspace, path: str, edits: List[Dict[str, Any]]) -> ToolResult:
    target = workspace.resolve(path)
    if not target.exists():
        return ToolResult(content=f"No such file: {path}", is_error=True)
    if not edits:
        return ToolResult(content="No edits given.", is_error=True)

    content = target.read_text(encoding="utf-8")
    for i, edit in enumerate(edits):
        old_text, new_text, replace_all = edit["old_text"], edit["new_text"], edit.get("replace_all", False)
        if old_text == new_text:
            return ToolResult(content=f"Edit {i}: old_text and new_text are identical - no edits were applied.", is_error=True)
        count = content.count(old_text)
        if count == 0:
            return ToolResult(content=f"Edit {i}: old_text not found (checked against the file after edits 0..{i - 1}) - no edits were applied.", is_error=True)
        if count > 1 and not replace_all:
            return ToolResult(content=f"Edit {i}: old_text matches {count} times - include more context, or set replace_all. No edits were applied.", is_error=True)
        content = content.replace(old_text, new_text, count if replace_all else 1)

    target.write_text(content, encoding="utf-8")
    return ToolResult(content=f"Applied {len(edits)} edit(s) to {path}")


def _list_files(workspace: Workspace, path: str) -> ToolResult:
    base = workspace.resolve(path)
    if not base.exists():
        return ToolResult(content=f"No such directory: {path}", is_error=True)
    skip = {"node_modules", ".git", "__pycache__", ".venv"}
    lines = []
    for entry in sorted(base.rglob("*")):
        if any(part in skip for part in entry.parts):
            continue
        rel = entry.relative_to(workspace.root)
        lines.append(f"{'d' if entry.is_dir() else 'f'} {rel.as_posix()}")
    return ToolResult(content=_truncate("\n".join(lines) or "(empty)"))


def _grep_search(workspace: Workspace, pattern: str, path: str) -> ToolResult:
    base = workspace.resolve(path)
    if not base.exists():
        return ToolResult(content=f"No such directory: {path}", is_error=True)

    warning = None
    try:
        regex = re.compile(pattern)
    except re.error as e:
        # Continue's grepSearch does the same thing when ripgrep rejects a pattern (exit code 2):
        # treat it as literal text instead of just failing, since a model often means "find this
        # string" and forgets that '.', '(', etc. are regex metacharacters.
        regex = re.compile(re.escape(pattern))
        warning = f"'{pattern}' is not valid regex ({e}); searched for it as literal text instead."

    skip = {"node_modules", ".git", "__pycache__", ".venv"}
    matches: List[str] = []
    char_count = 0
    truncation_reasons: List[str] = []

    for entry in sorted(base.rglob("*")):
        if truncation_reasons:
            break
        if entry.is_dir() or any(part in skip for part in entry.parts):
            continue
        rel = entry.relative_to(workspace.root).as_posix()
        if _is_secret_path(rel):
            continue
        try:
            text = entry.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError):
            continue  # binary or unreadable file - skip rather than error the whole search
        for i, line in enumerate(text.splitlines(), start=1):
            if not regex.search(line):
                continue
            entry_line = f"{rel}:{i}: {line.strip()}"
            matches.append(entry_line)
            char_count += len(entry_line)
            if len(matches) >= GREP_MAX_MATCHES:
                truncation_reasons.append(f"the number of results exceeded {GREP_MAX_MATCHES}")
                break
            if char_count >= GREP_MAX_CHARS:
                truncation_reasons.append(f"the number of characters exceeded {GREP_MAX_CHARS}")
                break

    body = "\n".join(matches) or "(no matches)"
    if truncation_reasons:
        body += f"\n...[truncated because {' and '.join(truncation_reasons)} - refine the pattern or path]"
    if warning:
        body = f"[{warning}]\n" + body
    return ToolResult(content=_truncate(body))


def _shell_argv(command: str) -> List[str]:
    """PowerShell on Windows, the user's actual login shell on POSIX - not Python's shell=True
    default (cmd.exe / a non-login /bin/sh), matching Continue's runTerminalCommand.ts. A login
    shell sources .bashrc/.zshrc, so PATH changes from nvm/pyenv/etc. apply to generated commands.

    PowerShell does NOT propagate a native command's exit code as its own process exit code by
    default (verified directly: running `python -c "sys.exit(3)"` via `-Command` alone exits 1,
    not 3) - a gap Continue's own implementation doesn't hit since it inspects the child process's
    code directly rather than the wrapper shell's. Appending `; exit $LASTEXITCODE` closes it."""
    if platform.system() == "Windows":
        return ["powershell.exe", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f"{command}; exit $LASTEXITCODE"]
    return [os.environ.get("SHELL", "/bin/bash"), "-l", "-c", command]


def _decode_output(data: bytes) -> str:
    """UTF-8 first, falling back to GBK if the result contains the U+FFFD replacement character -
    a plain UTF-8 decode mangles non-ASCII console output on Windows machines whose terminal code
    page is still a legacy one (very common on Chinese-locale Windows), per the same file."""
    if platform.system() == "Windows":
        text = data.decode("utf-8", errors="replace")
        if "�" in text:
            try:
                return data.decode("gbk", errors="replace")
            except LookupError:
                return text
        return text
    return data.decode("utf-8", errors="replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Returning None from redirect_request tells urllib not to follow it - it raises the redirect
    as an HTTPError instead, which _fetch_url turns into a message telling the model the new
    location rather than silently following it. Auto-following redirects is a known way an SSRF
    guard on the original URL gets bypassed (the redirect target is never re-checked); refusing to
    follow at all avoids that class of bug entirely instead of trying to re-validate every hop."""

    def redirect_request(self, *args, **kwargs):
        return None


def _unsafe_host_reason(hostname: str) -> Optional[str]:
    """None if the hostname resolves somewhere fine to fetch from; otherwise the reason it's
    refused. Nothing about an LLM tool call is more sensitive here than the fact that the model
    picks the URL - so it must not be able to reach localhost, RFC 1918 private ranges, or
    link-local addresses. That last one specifically includes 169.254.169.254, the cloud
    metadata endpoint AWS/GCP/Azure instances use to serve IAM credentials to anything that can
    reach it - a classic, well-documented SSRF target, not a theoretical one."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        return f"could not resolve host ({e})"
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return f"resolves to a non-public address ({ip})"
    return None


class _HTMLTextExtractor(HTMLParser):
    """A minimal, dependency-free HTML-to-text conversion: drop tags and script/style content,
    keep the rest, collapse whitespace. Good enough for a model to read a page; not a renderer."""

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._chunks: List[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in ("script", "style"):
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data.strip():
            self._chunks.append(data.strip())

    def text(self) -> str:
        return re.sub(r"[ \t]+", " ", " ".join(self._chunks)).strip()


def _fetch_url(url: str) -> ToolResult:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return ToolResult(content=f"Unsupported URL scheme '{parsed.scheme or '(none)'}' - only http and https are allowed.", is_error=True)
    if not parsed.hostname:
        return ToolResult(content="URL has no host.", is_error=True)

    unsafe_reason = _unsafe_host_reason(parsed.hostname)
    if unsafe_reason:
        return ToolResult(content=f"Refusing to fetch '{url}': {unsafe_reason} - not a public address.", is_error=True)

    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers={"User-Agent": "SpecForge-agent/1.0"})
    try:
        with opener.open(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            content_type = response.headers.get("Content-Type", "")
            raw = response.read(FETCH_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            location = e.headers.get("Location", "(no Location header)")
            return ToolResult(content=f"'{url}' redirects (HTTP {e.code}) to '{location}'. Redirects are not followed automatically - fetch that URL directly if you want it.", is_error=True)
        return ToolResult(content=f"HTTP {e.code} fetching '{url}': {e.reason}", is_error=True)
    except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
        return ToolResult(content=f"Failed to fetch '{url}': {e}", is_error=True)

    oversized = len(raw) > FETCH_MAX_BYTES
    raw = raw[:FETCH_MAX_BYTES]

    if "html" in content_type:
        extractor = _HTMLTextExtractor()
        extractor.feed(raw.decode("utf-8", errors="replace"))
        text = extractor.text()
    elif content_type.startswith("text/") or "json" in content_type or "xml" in content_type or not content_type:
        text = raw.decode("utf-8", errors="replace")
    else:
        return ToolResult(content=f"'{url}' has content-type '{content_type}', which isn't text - refusing to return binary content as text.", is_error=True)

    note = ""
    if len(text) > FETCH_TEXT_CHAR_LIMIT:
        text = text[:FETCH_TEXT_CHAR_LIMIT]
        note = f"\n...[truncated to {FETCH_TEXT_CHAR_LIMIT} characters]"
    elif oversized:
        note = "\n...[the response body was larger than we read; content may be incomplete]"
    return ToolResult(content=text + note)


def _run_shell(workspace: Workspace, command: str, wait: bool = True) -> ToolResult:
    argv = _shell_argv(command)
    if not wait:
        try:
            proc = subprocess.Popen(argv, cwd=workspace.root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            return ToolResult(content=f"Failed to start: {e}", is_error=True)
        return ToolResult(content=f"Started in the background (pid {proc.pid}): {command}\nNote: this process is not tracked further; stop it yourself (e.g. by port or pid) if needed.")

    try:
        proc = subprocess.run(argv, cwd=workspace.root, capture_output=True, timeout=SHELL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return ToolResult(content=f"Command timed out after {SHELL_TIMEOUT_SECONDS}s. If this is meant to keep running (e.g. a server), call again with wait=false.", is_error=True)
    except OSError as e:
        return ToolResult(content=f"Failed to start: {e}", is_error=True)
    stdout, stderr = _decode_output(proc.stdout), _decode_output(proc.stderr)
    output = f"$ {command}\n(exit {proc.returncode})\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
    return ToolResult(content=_truncate(output), is_error=proc.returncode != 0)
