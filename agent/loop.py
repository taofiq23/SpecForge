"""The agent loop itself - the one idea everything else in this project supports.

    while True:
        response = model.complete(system, messages, tools)   # model replies with text and/or tool calls
        if no tool calls:
            break                                              # model considers the task done
        for each tool call:
            result = tools.call(name, input)                   # actually do it
            append the result back into the conversation
    # repeat

This mirrors the core of Claude Code's own agent loop (see docs/how-it-works.md): tool results
always go back in as a *user*-role message (matching the Anthropic Messages API's turn-taking
requirement), and the loop's only stopping condition is the model choosing not to call a tool -
there is no separate "done" signal to invent.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .llm import LLMAdapter, ToolSpec
from .tools import ToolRegistry, ToolResult

DEFAULT_MAX_TURNS = 60

# Colors for terminal narration only - purely cosmetic, no effect on behavior. Safe to no-op:
# an ANSI-blind terminal just shows the raw escape codes' bytes as invisible control characters.
_ANSI_RESET = "\033[0m"
_ANSI_TURN = "\033[1;36m"      # bold cyan - turn headers
_ANSI_REASONING = "\033[97m"   # bright white - the model's own reasoning text
_ANSI_READONLY = "\033[1;32m"  # bold green - read-only tool calls
_ANSI_MUTATING = "\033[1;33m"  # bold yellow - mutating tool calls
_ANSI_PREVIEW = "\033[2;37m"   # dim gray - tool result previews
_ANSI_PLAN = "\033[1;35m"      # bold magenta - plan updates
_ANSI_DONE = "\033[1;32m"      # bold green - completion / stop messages


@dataclass
class PlanTracker:
    """A tiny stand-in for Claude Code's task system: lets the model keep a visible checklist of
    what it's doing, which the loop prints as it changes. Not needed for the loop to function -
    it exists so a person watching the agent run can see it working through the spec step by
    step, instead of a wall of silent tool calls."""

    steps: List[Dict[str, str]] = field(default_factory=list)  # [{"step": ..., "status": "pending"|"in_progress"|"done"}]

    def tool_spec(self) -> ToolSpec:
        return ToolSpec(
            name="update_plan",
            description="Record or update your checklist of steps for building the project. Call this whenever you start, finish, or add a step.",
            input_schema={
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"step": {"type": "string"}, "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}},
                            "required": ["step", "status"],
                        },
                    }
                },
                "required": ["steps"],
            },
        )

    def handle(self, input: Dict[str, Any]) -> ToolResult:
        self.steps = input["steps"]
        return ToolResult(content="Plan recorded.")

    def render(self) -> str:
        icon = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}
        return "\n".join(f"  {icon.get(s['status'], '[?]')} {s['step']}" for s in self.steps)


class AgentLoop:
    def __init__(self, llm: LLMAdapter, tools: ToolRegistry, system_prompt: str, max_turns: int = DEFAULT_MAX_TURNS, verbose: bool = True):
        self.llm = llm
        self.tools = tools
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self.verbose = verbose
        self.plan = PlanTracker()
        # Telemetry (item #15/#8 from the gap review): a run leaves an auditable record instead of
        # just scrolling past in the terminal - total tokens spent, and every action taken, tagged
        # mutating or read-only using the same ToolSpec.read_only flag the tools already carry.
        # That tagging is the part of a "real" permission system (item #7) that actually applies to
        # an unattended run: there's no one present to approve each action live, so what we can
        # honestly offer is a clear record of what changed, for a human to review afterward - not a
        # live gate pretending someone was watching.
        self.usage_totals: Dict[str, int] = {"input_tokens": 0, "output_tokens": 0}
        self.actions: List[Dict[str, Any]] = []  # [{"tool": ..., "mutating": bool, "is_error": bool}]
        self.stop_reason: Optional[str] = None  # "done" | "max_turns" | "interrupted"

    def _log(self, message: str, color: Optional[str] = None) -> None:
        if color and self.verbose:
            message = f"{color}{message}{_ANSI_RESET}"
        if not self.verbose:
            return
        try:
            print(message, file=sys.stdout, flush=True)
        except UnicodeEncodeError:
            # A real crash this hit at turn 90 of the actual run: stdout redirected to a file on
            # Windows defaults to the legacy console codepage (cp1252 here), which can't represent
            # every character a tool result might contain - non-English file content, npm's own
            # progress-bar output, etc. cli.py now asks for a UTF-8 stdout up front, which should
            # prevent this outright; this is the defense-in-depth fallback for when it's used some
            # other way. Narrating what the agent did must never be able to crash the run itself.
            encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
            safe = message.encode(encoding, errors="replace").decode(encoding, errors="replace")
            print(safe, file=sys.stdout, flush=True)

    def run(self, task: str) -> List[Dict[str, Any]]:
        all_tools = self.tools.specs + [self.plan.tool_spec()]
        read_only_by_name = {t.name: t.read_only for t in all_tools}
        messages: List[Dict[str, Any]] = [{"role": "user", "content": task}]
        started_at = time.monotonic()

        try:
            for turn in range(1, self.max_turns + 1):
                self._log(f"\n--- turn {turn} " + "-" * 50, color=_ANSI_TURN)
                response = self.llm.complete(self.system_prompt, messages, all_tools)
                messages.append({"role": "assistant", "content": response.content})
                for key in self.usage_totals:
                    self.usage_totals[key] += response.usage.get(key, 0)

                if response.text:
                    self._log(response.text, color=_ANSI_REASONING)

                if not response.tool_calls:
                    self._log("\n(model made no tool calls - considering the task complete)", color=_ANSI_DONE)
                    self.stop_reason = "done"
                    return messages

                tool_results = []
                for call in response.tool_calls:
                    mutating = not read_only_by_name.get(call["name"], False)
                    if call["name"] == "update_plan":
                        result = self.plan.handle(call["input"])
                        self._log("\nPlan:\n" + self.plan.render(), color=_ANSI_PLAN)
                    else:
                        tag = "mutating" if mutating else "read-only"
                        tag_color = _ANSI_MUTATING if mutating else _ANSI_READONLY
                        self._log(f"\n> [{tag}] {call['name']}({_short(call['input'])})", color=tag_color)
                        result = self.tools.call(call["name"], call["input"])
                        preview = result.content if len(result.content) < 300 else result.content[:300] + "..."
                        self._log(preview, color=_ANSI_PREVIEW)
                    self.actions.append({"tool": call["name"], "mutating": mutating, "is_error": result.is_error})
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": call["id"], "content": result.content, "is_error": result.is_error}
                    )
                messages.append({"role": "user", "content": tool_results})

            self._log(f"\n(stopped after the {self.max_turns}-turn safety limit)", color=_ANSI_MUTATING)
            self.stop_reason = "max_turns"
            return messages
        except KeyboardInterrupt:
            self._log(
                "\n\n(interrupted - stopping after the current step; the project has whatever was written so far)",
                color=_ANSI_MUTATING,
            )
            self.stop_reason = "interrupted"
            return messages
        finally:
            self.elapsed_seconds = round(time.monotonic() - started_at, 1)

    def stats(self) -> Dict[str, Any]:
        mutating = [a for a in self.actions if a["mutating"]]
        return {
            "stop_reason": self.stop_reason,
            "elapsed_seconds": getattr(self, "elapsed_seconds", None),
            "usage": dict(self.usage_totals),
            "total_actions": len(self.actions),
            "mutating_actions": len(mutating),
            "failed_actions": len([a for a in self.actions if a["is_error"]]),
            "actions_by_tool": {name: len([a for a in self.actions if a["tool"] == name]) for name in {a["tool"] for a in self.actions}},
        }


def _short(d: Dict[str, Any]) -> str:
    parts = []
    for k, v in d.items():
        text = str(v)
        parts.append(f"{k}={text[:60]!r}{'...' if len(text) > 60 else ''}")
    return ", ".join(parts)
