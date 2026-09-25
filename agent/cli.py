"""Entry point.

    python -m agent.cli --arch-doc spec/Architecture_Documentation.md \\
                         --arch-view spec/Architecture_View.md \\
                         --out generated-project \\
                         --provider anthropic
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .conformance import check_conformance, extend_traceability_matrix, render_report_markdown
from .llm import build_adapter
from .loop import AgentLoop
from .preprocess import build_spec
from .prompts import SYSTEM_PROMPT
from .tools import Workspace, make_tools
from .uml_parse import merge_diagrams


def _force_utf8_console() -> None:
    """A real run crashed at turn 90 (UnicodeEncodeError) because stdout, redirected to a file on
    Windows, defaults to the console's legacy codepage (cp1252 here) - which can't represent every
    character a tool result might contain (npm's own progress output, in that case). Reconfiguring
    to UTF-8 up front is the actual fix; loop.py's _log has a defensive fallback for anywhere this
    isn't called, but this is where the problem is actually solved rather than papered over."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    _force_utf8_console()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arch-doc", type=Path, required=True, help="Path to Architecture_Documentation.md")
    parser.add_argument("--arch-view", type=Path, required=True, help="Path to Architecture_View.md")
    parser.add_argument("--out", type=Path, required=True, help="Directory to generate the project into")
    parser.add_argument("--provider", default="anthropic", choices=["anthropic", "deepseek", "openai"])
    parser.add_argument("--max-turns", type=int, default=60)
    parser.add_argument("--skip-conformance", action="store_true", help="Skip the architecture conformance check after generation.")
    args = parser.parse_args()

    print(f"[1/3] Parsing {args.arch_doc.name} and {args.arch_view.name} into a structured spec...")
    spec = build_spec(args.arch_doc, args.arch_view)
    args.out.mkdir(parents=True, exist_ok=True)
    spec_path = args.out / "spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    n_diagrams = len(spec["views"]["diagrams"])
    n_reqs = len(spec["architecture"]["traceability_matrix"])
    print(f"      -> {n_reqs} traceability rows, {n_diagrams} diagrams, {len(spec['architecture']['components'])} components")

    print(f"[2/3] Starting the agent (provider={args.provider}) with workspace {args.out}...")
    workspace = Workspace(args.out)
    tools = make_tools(workspace)
    llm = build_adapter(args.provider)
    agent = AgentLoop(llm=llm, tools=tools, system_prompt=SYSTEM_PROMPT, max_turns=args.max_turns)

    existing_files = [p for p in workspace.root.rglob("*") if p.is_file() and p.name != "spec.json" and "node_modules" not in p.parts]
    resume_note = (
        f"\n\nNOTE: this project root already has {len(existing_files)} file(s) in it - this looks like a "
        "resumed run (e.g. after a crash or interruption). Start with list_files and read_file on the "
        "existing pieces before writing anything, so you build on what's there instead of redoing or "
        "conflicting with it. Update your plan to reflect what's already done."
        if existing_files
        else ""
    )
    task = (
        "Build the project described by the attached spec. The full parsed spec is in spec.json "
        "in your project root (read it with read_file). Here is the raw architecture doc's "
        "component list and deliverables for quick reference:\n\n"
        f"Components: {spec['architecture']['components']}\n"
        f"Deliverables: {spec['architecture']['deliverables']}\n"
        f"Architectural style: {spec['architecture']['architectural_style']}\n\n"
        "Begin by reading spec.json, then call update_plan with your checklist."
        f"{resume_note}"
    )

    print("[3/3] Running...\n")
    messages = agent.run(task)
    stats = agent.stats()

    # Telemetry: an auditable record of the run survives the terminal scrolling past it - every
    # message (including full tool inputs/outputs) plus the summary stats (tokens, action counts,
    # mutating-vs-read-only breakdown, stop reason), written next to the generated project.
    (args.out / "run_transcript.json").write_text(json.dumps(messages, indent=2), encoding="utf-8")
    (args.out / "run_stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")

    print(f"\nDone (stop reason: {stats['stop_reason']}). {stats['total_actions']} actions "
          f"({stats['mutating_actions']} mutating, {stats['failed_actions']} failed), "
          f"{sum(stats['usage'].values())} tokens, {stats['elapsed_seconds']}s.")
    print(f"See {args.out} for the generated project, run_transcript.json for the full record, and run_stats.json for the summary.")

    if not args.skip_conformance:
        print("\n[extra] Checking generated code against the UML diagrams (architecture conformance)...")
        diagram = merge_diagrams([d["plantuml"] for d in spec["views"]["diagrams"]])
        report = check_conformance(diagram, workspace)
        extended_matrix = extend_traceability_matrix(spec["architecture"]["traceability_matrix"], report)
        (args.out / "conformance_report.json").write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
        (args.out / "CONFORMANCE_REPORT.md").write_text(render_report_markdown(report, extended_matrix), encoding="utf-8")
        print(f"      strict score: {report.strict_score:.0%}  |  lenient score: {report.lenient_score:.0%}  -> CONFORMANCE_REPORT.md")


if __name__ == "__main__":
    main()
