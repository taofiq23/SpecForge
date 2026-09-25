"""Converts the two input markdown files into one structured JSON spec, so the agent plans from
data instead of re-reading raw markdown on every turn (the task's own suggestion). Parsing is
deterministic (regex over the markdown), not model-driven - a foundational input like this should
be exact, not an LLM's best guess at structure.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

SECTION_RE = re.compile(r"^#\s+([A-Z])\.\s+(.+)$", re.MULTILINE)
CODE_BLOCK_RE = re.compile(r"```(\w+)\n(.*?)```", re.DOTALL)
TABLE_ROW_RE = re.compile(r"^\|(.+)\|$", re.MULTILINE)


@dataclass
class ArchitectureDoc:
    executive_summary: str
    architectural_style: Optional[str]
    deployment_topology: Optional[str]
    traceability_matrix: List[Dict[str, str]]
    components: List[str]
    deliverables: List[str]
    sections: Dict[str, str]  # letter -> raw markdown body, for anything the structured fields don't capture
    code_blocks: List[Dict[str, str]]  # [{"section": "D", "language": "yml", "content": "..."}]


@dataclass
class ViewDiagram:
    view: str  # e.g. "ScenarioView"
    number: int
    title: str  # e.g. "UseCase — Scenario View: Use Case Diagram"
    diagram_name: str  # the @startuml identifier, e.g. "UseCaseDiagram"
    plantuml: str


@dataclass
class ArchitectureView:
    diagrams: List[ViewDiagram] = field(default_factory=list)


def parse_architecture_doc(text: str) -> ArchitectureDoc:
    sections: Dict[str, str] = {}
    matches = list(SECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        letter = m.group(1)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[letter] = text[start:end].strip()

    executive_summary = sections.get("A", "").split("\n\n")[0].strip()

    style_match = re.search(r"Chosen architectural style:\s*(.+)", sections.get("A", ""))
    topology_match = re.search(r"Deployment topology:\s*(.+)", sections.get("A", ""))

    traceability_matrix = _parse_table(sections.get("B", ""))
    for row in traceability_matrix:
        row["diagrams"] = [d.strip() for d in row.get("diagram(s)", "").split(",") if d.strip()]
        row["components"] = [c.strip() for c in row.get("component(s)", "").split(",") if c.strip()]

    components = re.findall(r"^\*\s+(\w+):", sections.get("C", ""), re.MULTILINE)

    deliverables_block = sections.get("L", "")
    deliverables_match = re.search(r"```markdown\n(.*?)```", deliverables_block, re.DOTALL)
    deliverables = [line.strip() for line in deliverables_match.group(1).splitlines() if line.strip()] if deliverables_match else []

    code_blocks = []
    for letter, body in sections.items():
        for lang, content in CODE_BLOCK_RE.findall(body):
            if lang == "markdown":  # that's the deliverables file list, already captured above
                continue
            code_blocks.append({"section": letter, "language": lang, "content": content.strip()})

    return ArchitectureDoc(
        executive_summary=executive_summary,
        architectural_style=style_match.group(1).strip() if style_match else None,
        deployment_topology=topology_match.group(1).strip() if topology_match else None,
        traceability_matrix=traceability_matrix,
        components=components,
        deliverables=deliverables,
        sections=sections,
        code_blocks=code_blocks,
    )


def _parse_table(section_text: str) -> List[Dict[str, str]]:
    rows = TABLE_ROW_RE.findall(section_text)
    if len(rows) < 2:
        return []
    header = [h.strip().lower() for h in rows[0].split("|")]
    records = []
    for row in rows[2:]:  # row[1] is the '---' separator
        cells = [c.strip() for c in row.split("|")]
        if len(cells) != len(header):
            continue
        records.append(dict(zip(header, cells)))
    return records


VIEW_HEADING_RE = re.compile(r"^##\s+(\w+)\s*$", re.MULTILINE)
DIAGRAM_TITLE_RE = re.compile(r"^(\d+)\.\s+(.+)$", re.MULTILINE)
PLANTUML_BLOCK_RE = re.compile(r"```plantuml\n@startuml\s+(\S+)\n(.*?)@enduml\n```", re.DOTALL)


def parse_architecture_view(text: str) -> ArchitectureView:
    view_headings = list(VIEW_HEADING_RE.finditer(text))
    diagrams: List[ViewDiagram] = []
    number = 0
    title = ""

    for m in DIAGRAM_TITLE_RE.finditer(text):
        number, title = int(m.group(1)), m.group(2).strip()
        # the plantuml block(s) immediately following this title, up to the next numbered title
        next_title = DIAGRAM_TITLE_RE.search(text, m.end())
        chunk_end = next_title.start() if next_title else len(text)
        chunk = text[m.end():chunk_end]
        current_view = _view_for_position(view_headings, m.start())
        for name, body in PLANTUML_BLOCK_RE.findall(chunk):
            diagrams.append(ViewDiagram(view=current_view, number=number, title=title, diagram_name=name, plantuml=body.strip()))

    return ArchitectureView(diagrams=diagrams)


def _view_for_position(view_headings: List[re.Match], pos: int) -> str:
    current = "Unknown"
    for m in view_headings:
        if m.start() > pos:
            break
        current = m.group(1)
    return current


def build_spec(architecture_doc_path: Path, architecture_view_path: Path) -> Dict[str, Any]:
    arch = parse_architecture_doc(architecture_doc_path.read_text(encoding="utf-8"))
    views = parse_architecture_view(architecture_view_path.read_text(encoding="utf-8"))
    return {"architecture": asdict(arch), "views": asdict(views)}


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--architecture-doc", type=Path, required=True)
    parser.add_argument("--architecture-view", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    spec = build_spec(args.architecture_doc, args.architecture_view)
    args.out.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Wrote {args.out} ({len(spec['architecture']['traceability_matrix'])} traceability rows, {len(spec['views']['diagrams'])} diagrams)")


if __name__ == "__main__":
    main()
