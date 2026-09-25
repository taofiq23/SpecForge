from agent.uml_parse import merge_diagrams, parse_plantuml

CLASS_DIAGRAM = """
@startuml ClassDiagram
class Game {
  - id: string
  - score: int
  + play(): void
  + viewScore(): int
}
class Question {
  - id: string
  + getPrompt(): string
}
Game --* Question
@enduml
"""

COMPONENT_DIAGRAM = """
@startuml ComponentDiagram
artifact GameComponent
artifact QuestionComponent
GameComponent -- QuestionComponent
@enduml
"""

PACKAGE_DIAGRAM = """
@startuml PackageDiagram
package Game {
  class Game
  class Question
}
package User {
  class User
}
Game -- User
@enduml
"""

OBJECT_DIAGRAM = """
@startuml ObjectDiagram
participant game1
participant question1
game1 --> question1
@enduml
"""


def test_parses_class_names_fields_and_methods():
    diagram = parse_plantuml(CLASS_DIAGRAM)
    assert set(diagram.classes) == {"Game", "Question"}
    assert diagram.classes["Game"].fields == ["id", "score"]
    assert diagram.classes["Game"].methods == ["play", "viewScore"]
    assert diagram.classes["Question"].fields == ["id"]
    assert diagram.classes["Question"].methods == ["getPrompt"]


def test_parses_class_relationship_without_confusing_it_with_method_lines():
    diagram = parse_plantuml(CLASS_DIAGRAM)
    # the '+ viewScore(): int' method line must not be picked up as a bare relationship
    assert diagram.relationships == [("Game", "Question")]


def test_parses_component_diagram_artifacts_and_relationship():
    diagram = parse_plantuml(COMPONENT_DIAGRAM)
    assert diagram.elements == ["GameComponent", "QuestionComponent"]
    assert diagram.relationships == [("GameComponent", "QuestionComponent")]


def test_parses_package_diagram_members_and_relationship():
    diagram = parse_plantuml(PACKAGE_DIAGRAM)
    assert diagram.packages == {"Game": ["Game", "Question"], "User": ["User"]}
    assert diagram.relationships == [("Game", "User")]


def test_object_diagram_instances_are_captured_too_not_treated_specially():
    # uml_parse extracts everything mentioned; deciding what counts as "verifiable architecture"
    # (vs. object-diagram instances or state names) is conformance.py's job, not this module's.
    diagram = parse_plantuml(OBJECT_DIAGRAM)
    assert diagram.relationships == [("game1", "question1")]


def test_merge_diagrams_unions_classes_elements_and_deduplicates_relationships():
    merged = merge_diagrams([CLASS_DIAGRAM, COMPONENT_DIAGRAM, CLASS_DIAGRAM])  # CLASS_DIAGRAM repeated on purpose
    assert set(merged.classes) == {"Game", "Question"}
    assert merged.elements == ["GameComponent", "QuestionComponent"]
    assert merged.relationships.count(("Game", "Question")) == 1  # not doubled by the repeat
    assert ("GameComponent", "QuestionComponent") in merged.relationships


def test_real_task_spec_parses_completely():
    import json
    from pathlib import Path

    spec_path = Path(__file__).resolve().parent.parent / "spec" / "spec.json"
    if not spec_path.exists():
        return  # optional integration check, like the equivalent one in test_preprocess.py
    spec = json.loads(spec_path.read_text())
    merged = merge_diagrams([d["plantuml"] for d in spec["views"]["diagrams"]])
    assert set(merged.classes) == {"Game", "Question", "User", "Admin"}
    assert "GameComponent" in merged.elements
    assert ("GameComponent", "QuestionComponent") in merged.relationships
