from typing import Any, Dict, List

from agent.llm import LLMAdapter, LLMResponse, ToolSpec
from agent.loop import AgentLoop
from agent.tools import Workspace, make_tools


class ScriptedLLM(LLMAdapter):
    """Replays a fixed sequence of responses, one per call to complete() - lets us test the loop's
    mechanics (does it execute tools, append results, stop correctly) without a real model or any
    network access."""

    def __init__(self, responses: List[LLMResponse]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []  # records (system, messages, tools) for each call, for assertions

    def complete(self, system: str, messages, tools: List[ToolSpec]) -> LLMResponse:
        self.calls.append({"system": system, "messages": [dict(m) for m in messages], "tools": [t.name for t in tools]})
        return self._responses.pop(0)


def _text(s: str) -> Dict[str, Any]:
    return {"type": "text", "text": s}


def _tool_use(id: str, name: str, input: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "tool_use", "id": id, "name": name, "input": input}


def test_loop_executes_a_tool_call_and_stops_on_a_plain_text_reply(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    llm = ScriptedLLM(
        [
            LLMResponse(content=[_text("Writing the readme."), _tool_use("1", "write_file", {"path": "README.md", "content": "hi"})], stop_reason="tool_use"),
            LLMResponse(content=[_text("Done.")], stop_reason="end_turn"),
        ]
    )
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", verbose=False)

    messages = agent.run("build it")

    assert (workspace.root / "README.md").read_text() == "hi"
    assert len(llm.calls) == 2  # one turn per scripted response
    # the tool's result was appended back as a user-role tool_result before the second call
    second_call_messages = llm.calls[1]["messages"]
    tool_result_msg = second_call_messages[-1]
    assert tool_result_msg["role"] == "user"
    assert tool_result_msg["content"][0]["type"] == "tool_result"
    assert tool_result_msg["content"][0]["tool_use_id"] == "1"
    assert not tool_result_msg["content"][0]["is_error"]
    # final message list ends with the assistant's plain-text close, no dangling tool call
    assert messages[-1] == {"role": "assistant", "content": [_text("Done.")]}


def test_loop_stops_immediately_if_the_first_reply_has_no_tool_calls(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    llm = ScriptedLLM([LLMResponse(content=[_text("Nothing to do.")], stop_reason="end_turn")])
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", verbose=False)

    messages = agent.run("build it")

    assert len(llm.calls) == 1
    assert messages == [{"role": "user", "content": "build it"}, {"role": "assistant", "content": [_text("Nothing to do.")]}]


def test_loop_reports_tool_errors_back_to_the_model_instead_of_crashing(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    llm = ScriptedLLM(
        [
            LLMResponse(content=[_tool_use("1", "read_file", {"path": "missing.txt"})], stop_reason="tool_use"),
            LLMResponse(content=[_text("ok, giving up")], stop_reason="end_turn"),
        ]
    )
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", verbose=False)

    messages = agent.run("build it")

    # messages: [user task, assistant tool_use, user tool_result, assistant final text]
    tool_result = messages[2]["content"][0]
    assert tool_result["is_error"] is True
    assert "No such file" in tool_result["content"]


def test_loop_honors_the_max_turns_safety_cap(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    # every response asks for another tool call - an agent that never stops on its own
    infinite = [LLMResponse(content=[_tool_use(str(i), "list_files", {})], stop_reason="tool_use") for i in range(100)]
    llm = ScriptedLLM(infinite)
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", max_turns=5, verbose=False)

    agent.run("loop forever")

    assert len(llm.calls) == 5
    assert agent.stop_reason == "max_turns"


def test_stats_track_usage_and_tag_actions_mutating_vs_read_only(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    llm = ScriptedLLM(
        [
            LLMResponse(
                content=[_tool_use("1", "write_file", {"path": "a.txt", "content": "x"}), _tool_use("2", "list_files", {})],
                stop_reason="tool_use",
                usage={"input_tokens": 100, "output_tokens": 20},
            ),
            LLMResponse(content=[_text("done")], stop_reason="end_turn", usage={"input_tokens": 50, "output_tokens": 5}),
        ]
    )
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", verbose=False)

    agent.run("build it")
    stats = agent.stats()

    assert stats["usage"] == {"input_tokens": 150, "output_tokens": 25}
    assert stats["stop_reason"] == "done"
    assert stats["total_actions"] == 2
    assert stats["mutating_actions"] == 1  # write_file mutates, list_files doesn't
    assert stats["failed_actions"] == 0
    assert stats["actions_by_tool"] == {"write_file": 1, "list_files": 1}
    assert isinstance(stats["elapsed_seconds"], float)


def test_a_keyboard_interrupt_mid_run_stops_gracefully_and_keeps_partial_progress(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)

    class InterruptingLLM(LLMAdapter):
        def complete(self, system, messages, tools):
            if len(messages) == 1:
                return LLMResponse(content=[_tool_use("1", "write_file", {"path": "a.txt", "content": "saved before interrupt"})], stop_reason="tool_use")
            raise KeyboardInterrupt

    agent = AgentLoop(llm=InterruptingLLM(), tools=tools, system_prompt="sys", verbose=False)

    messages = agent.run("build it")  # must not raise

    assert agent.stop_reason == "interrupted"
    assert (workspace.root / "a.txt").read_text() == "saved before interrupt"  # the write before the interrupt was not lost
    assert messages[-1]["role"] == "user"  # last thing recorded is the tool result from before the interrupt


def test_update_plan_tool_is_handled_by_the_loop_not_the_tool_registry(tmp_path):
    workspace = Workspace(tmp_path / "proj")
    tools = make_tools(workspace)
    llm = ScriptedLLM(
        [
            LLMResponse(content=[_tool_use("1", "update_plan", {"steps": [{"step": "write readme", "status": "in_progress"}]})], stop_reason="tool_use"),
            LLMResponse(content=[_text("done")], stop_reason="end_turn"),
        ]
    )
    agent = AgentLoop(llm=llm, tools=tools, system_prompt="sys", verbose=False)

    agent.run("build it")

    assert agent.plan.steps == [{"step": "write readme", "status": "in_progress"}]
    # update_plan must be offered to the model even though it isn't in the tool registry
    assert "update_plan" in llm.calls[0]["tools"]
