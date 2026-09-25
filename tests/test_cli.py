from unittest.mock import MagicMock

from agent.cli import _force_utf8_console


def test_force_utf8_console_reconfigures_stdout_and_stderr(monkeypatch):
    fake_stdout, fake_stderr = MagicMock(), MagicMock()
    monkeypatch.setattr("agent.cli.sys.stdout", fake_stdout)
    monkeypatch.setattr("agent.cli.sys.stderr", fake_stderr)

    _force_utf8_console()

    fake_stdout.reconfigure.assert_called_once_with(encoding="utf-8", errors="replace")
    fake_stderr.reconfigure.assert_called_once_with(encoding="utf-8", errors="replace")


def test_force_utf8_console_does_not_crash_on_a_stream_without_reconfigure(monkeypatch):
    class NoReconfigure:
        pass

    monkeypatch.setattr("agent.cli.sys.stdout", NoReconfigure())
    monkeypatch.setattr("agent.cli.sys.stderr", NoReconfigure())

    _force_utf8_console()  # must not raise
