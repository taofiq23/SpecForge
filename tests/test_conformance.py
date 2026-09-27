from agent.conformance import check_conformance, extend_traceability_matrix, render_report_markdown
from agent.tools import Workspace
from agent.uml_parse import merge_diagrams

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
class Admin {
  - id: string
  + updateQuestions(): void
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


def _diagram():
    return merge_diagrams([CLASS_DIAGRAM, COMPONENT_DIAGRAM])


def test_fully_implemented_project_scores_100_percent(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text(
        "class Game:\n"
        "    def play(self):\n"
        "        return Question().getPrompt()\n"
        "    def viewScore(self):\n"
        "        return self.score\n"
    )
    (ws.root / "question.py").write_text("class Question:\n    def getPrompt(self):\n        return 'x'\n")
    (ws.root / "admin.py").write_text("class Admin:\n    def updateQuestions(self):\n        pass\n")
    (ws.root / "game_component.py").write_text("class GameComponent:\n    \"\"\"Wraps Game and talks to QuestionComponent.\"\"\"\n")
    (ws.root / "question_component.py").write_text("class QuestionComponent:\n    pass\n")

    report = check_conformance(_diagram(), ws)

    assert report.strict_score == 1.0
    assert all(e.status == "implemented" for e in report.elements)
    game_check = next(e for e in report.elements if e.name == "Game")
    assert game_check.methods_found == ["play", "viewScore"]
    assert game_check.methods_missing == []


def test_missing_class_is_reported_as_missing_not_implemented(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    def play(self):\n        pass\n")
    # Question and Admin and both components are never written at all

    report = check_conformance(_diagram(), ws)

    question = next(e for e in report.elements if e.name == "Question")
    admin = next(e for e in report.elements if e.name == "Admin")
    assert question.status == "missing"
    assert admin.status == "missing"
    assert report.strict_score < 1.0


def test_bare_name_without_a_class_declaration_is_referenced_not_implemented(tmp_path):
    ws = Workspace(tmp_path / "proj")
    # A functional/procedural style: "Game" logic exists as functions, never as a formal class.
    (ws.root / "game.py").write_text("def play_game():\n    pass\n\nGAME_NAME = 'Game'\n")

    report = check_conformance(_diagram(), ws)

    game = next(e for e in report.elements if e.name == "Game")
    assert game.status == "referenced"  # found the bare word, not a class declaration
    assert game.status != "implemented"


def test_infra_element_with_labeled_architecture_comment_counts_as_implemented(tmp_path):
    # Real gap this closes: a deployment/container-diagram element (kind="component" here, same
    # as GameComponent) is infrastructure, not a language class - "class GameComponent" style
    # matching can never find it in a docker-compose.yml or k8s manifest. A deliberate, labeled
    # "# Architecture Node: <name>" comment is the honest equivalent of a declaration for these.
    ws = Workspace(tmp_path / "proj")
    (ws.root / "docker-compose.yml").write_text(
        "services:\n"
        "  game:\n"
        "    # Architecture Node: GameComponent\n"
        "    image: game:latest\n"
    )
    (ws.root / "game.py").write_text("class Game:\n    def play(self): pass\n    def viewScore(self): pass\n")

    report = check_conformance(_diagram(), ws)

    game_component = next(e for e in report.elements if e.name == "GameComponent")
    assert game_component.status == "implemented"


def test_infra_element_without_the_labeled_comment_stays_referenced(tmp_path):
    # The name alone (no labeled comment) must not be enough - otherwise this would just be a
    # second bare-name match, defeating the point of requiring a deliberate declaration.
    ws = Workspace(tmp_path / "proj")
    (ws.root / "docker-compose.yml").write_text("services:\n  game:\n    # GameComponent runs here\n")
    (ws.root / "game.py").write_text("class Game:\n    def play(self): pass\n    def viewScore(self): pass\n")

    report = check_conformance(_diagram(), ws)

    game_component = next(e for e in report.elements if e.name == "GameComponent")
    assert game_component.status == "referenced"


def test_strict_score_is_never_inflated_by_referenced_only_matches(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "notes.py").write_text("# mentions Game, Question, Admin, GameComponent, QuestionComponent in a comment\n")

    report = check_conformance(_diagram(), ws)

    assert all(e.status == "referenced" for e in report.elements)
    assert report.strict_score == 0.0  # comments mentioning names are not implementations
    assert report.lenient_score > 0.0  # but they are worth partial, disclosed credit


def test_relationship_found_only_when_b_appears_in_a_files_specifically(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    def play(self):\n        return Question()\n")
    (ws.root / "question.py").write_text("class Question:\n    pass\n")
    (ws.root / "unrelated.py").write_text("QuestionComponent = None\n")  # Question mentioned, but not in game.py

    report = check_conformance(merge_diagrams([CLASS_DIAGRAM]), ws)

    rel = next(r for r in report.relationships if r.a == "Game" and r.b == "Question")
    assert rel.status == "found"
    assert rel.evidence.file == "game.py"


def test_relationship_missing_when_dependent_class_itself_is_missing(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    pass\n")
    # Game exists but never mentions Question anywhere

    report = check_conformance(merge_diagrams([CLASS_DIAGRAM]), ws)

    rel = next(r for r in report.relationships if r.a == "Game" and r.b == "Question")
    assert rel.status == "missing"


def test_object_diagram_noise_never_reaches_relationship_checks(tmp_path):
    object_diagram = """
    @startuml ObjectDiagram
    participant game1
    participant question1
    game1 --> question1
    @enduml
    """
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    pass\n")

    report = check_conformance(merge_diagrams([CLASS_DIAGRAM, object_diagram]), ws)

    assert not any(r.a == "game1" for r in report.relationships)  # instance names, not classes - filtered out


def test_extend_traceability_matrix_marks_a_row_verified_only_when_every_component_is_implemented(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    def play(self):\n        pass\n")
    (ws.root / "question.py").write_text("class Question:\n    pass\n")
    # Admin is never written

    report = check_conformance(_diagram(), ws)
    matrix = [
        {"requirement id": "FR-1", "short text": "Play game", "components": ["Game"]},
        {"requirement id": "FR-2", "short text": "Update questions", "components": ["Admin"]},
    ]
    extended = extend_traceability_matrix(matrix, report)

    assert extended[0]["verified"] is True
    assert extended[1]["verified"] is False
    assert extended[1]["component_statuses"] == {"Admin": "missing"}


def test_bookkeeping_files_are_never_counted_as_evidence(tmp_path):
    """Regression test for a real bug: the first actual run scored classes as 'found' purely
    because spec.json (containing the raw PlantUML) and run_transcript.json (which quotes the
    whole conversation, including spec.json's own content) were swept into the same search as
    real source files. Every name in a diagram trivially appears in the spec that describes it,
    so without this exclusion, nothing can ever be told apart from a project with zero real code."""
    ws = Workspace(tmp_path / "proj")
    (ws.root / "spec.json").write_text('{"classes": ["Game", "Question", "Admin"]}')
    (ws.root / "run_transcript.json").write_text('[{"content": "class Game {} class Question {} class Admin {}"}]')
    # No real source file exists at all.

    report = check_conformance(_diagram(), ws)

    assert all(e.status == "missing" for e in report.elements)
    assert report.strict_score == 0.0
    assert report.lenient_score == 0.0


def test_render_report_markdown_includes_scores_and_tables(tmp_path):
    ws = Workspace(tmp_path / "proj")
    (ws.root / "game.py").write_text("class Game:\n    def play(self):\n        pass\n")
    report = check_conformance(merge_diagrams([CLASS_DIAGRAM]), ws)
    extended = extend_traceability_matrix([{"requirement id": "FR-1", "short text": "Play", "components": ["Game"]}], report)

    markdown = render_report_markdown(report, extended)

    assert "Strict score:" in markdown and "Lenient score:" in markdown
    assert "| Game |" in markdown
    assert "FR-1" in markdown
