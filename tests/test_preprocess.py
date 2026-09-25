from pathlib import Path

from agent.preprocess import build_spec, parse_architecture_doc, parse_architecture_view

FIXTURE_DOC = """\
# A. Executive Summary
The Widget system is a thing.

Chosen architectural style: Microservices
Deployment topology: Cloud-based infrastructure

# B. Traceability & Rationale
| Requirement ID | Short Text | Diagram(s) | Component(s) | Artifact filename(s) | Rationale |
| --- | --- | --- | --- | --- | --- |
| FR-1 | Do thing | UseCaseDiagram | WidgetComponent | openapi.yaml | Lets users do the thing |

# C. Architecture Overview
* WidgetComponent: does the thing
* OtherComponent: does another thing

# D. Detailed Technical Design
```yml
key: value
```

# L. Deliverables
```markdown
architecture.md
openapi.yaml
```
"""

FIXTURE_VIEW = """\
## ScenarioView
1. UseCase — Scenario View: Use Case Diagram
```plantuml
@startuml UseCaseDiagram
actor User
User -- (DoThing)
@enduml
```

## ProcessView
2. Sequence — Process View: Sequence Diagram
```plantuml
@startuml SequenceDiagram1
participant User
User->>Widget: doThing()
@enduml
```
```plantuml
@startuml SequenceDiagram2
participant Admin
Admin->>Widget: reset()
@enduml
```
"""


def test_parse_architecture_doc_extracts_style_and_topology():
    doc = parse_architecture_doc(FIXTURE_DOC)
    assert doc.architectural_style == "Microservices"
    assert doc.deployment_topology == "Cloud-based infrastructure"


def test_parse_architecture_doc_extracts_traceability_matrix():
    doc = parse_architecture_doc(FIXTURE_DOC)
    assert len(doc.traceability_matrix) == 1
    row = doc.traceability_matrix[0]
    assert row["requirement id"] == "FR-1"
    assert row["diagrams"] == ["UseCaseDiagram"]
    assert row["components"] == ["WidgetComponent"]


def test_parse_architecture_doc_extracts_components():
    doc = parse_architecture_doc(FIXTURE_DOC)
    assert doc.components == ["WidgetComponent", "OtherComponent"]


def test_parse_architecture_doc_extracts_deliverables_not_all_code_blocks():
    doc = parse_architecture_doc(FIXTURE_DOC)
    assert doc.deliverables == ["architecture.md", "openapi.yaml"]


def test_parse_architecture_doc_collects_code_blocks_by_section():
    doc = parse_architecture_doc(FIXTURE_DOC)
    d_blocks = [b for b in doc.code_blocks if b["section"] == "D"]
    assert len(d_blocks) == 1
    assert d_blocks[0]["language"] == "yml"
    assert "key: value" in d_blocks[0]["content"]


def test_parse_architecture_view_finds_every_diagram_including_multiple_per_number():
    view = parse_architecture_view(FIXTURE_VIEW)
    names = [(d.number, d.diagram_name, d.view) for d in view.diagrams]
    assert names == [
        (1, "UseCaseDiagram", "ScenarioView"),
        (2, "SequenceDiagram1", "ProcessView"),
        (2, "SequenceDiagram2", "ProcessView"),
    ]


def test_parse_architecture_view_captures_plantuml_body():
    view = parse_architecture_view(FIXTURE_VIEW)
    use_case = next(d for d in view.diagrams if d.diagram_name == "UseCaseDiagram")
    assert "actor User" in use_case.plantuml
    assert "@startuml" not in use_case.plantuml  # body only, markers stripped


def test_build_spec_end_to_end_on_the_real_task_files_if_present():
    doc_path = Path(__file__).resolve().parent.parent / "spec" / "Architecture_Documentation.md"
    view_path = Path(__file__).resolve().parent.parent / "spec" / "Architecture_View.md"
    if not (doc_path.exists() and view_path.exists()):
        return  # optional integration check; the unit tests above don't depend on these files
    spec = build_spec(doc_path, view_path)
    assert spec["architecture"]["architectural_style"] == "Microservices"
    assert len(spec["views"]["diagrams"]) == 13
    assert len(spec["architecture"]["traceability_matrix"]) == 3
