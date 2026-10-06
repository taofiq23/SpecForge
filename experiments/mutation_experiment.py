"""Mutation analysis of this project's own architecture-conformance checker.

A conformance score only means something if it would have dropped had the architecture
not been implemented. This script tests that claim the standard way: inject a defect you
know is there, re-run the checker, and see whether it reports it.

Each mutation is applied to a fresh copy of generated-project (which scores 100%/100%
unmodified), and each one asserts that its edit actually landed before the checker runs,
so a "not detected" result cannot be an artifact of a failed edit.

Result as of this commit - four real defects, none detected:

    scenario                                          strict  lenient  caught?
    baseline                                            100%     100%  -
    real `class Game` declaration deleted               100%     100%  no
    real Game.play() body deleted                       100%     100%  no
    all 8 infra annotations moved to a flat .md list    100%     100%  no
    docker-compose.yml deleted entirely                 100%     100%  no
    one annotation *comment* deleted                     87%      88%  yes

The only change the checker notices is the one that alters no behaviour at all. Deleting
a single `# Architecture Node:` comment costs 13 points; deleting the entire deployment
file that comment is attached to costs nothing. The metric tracks its own annotations
rather than the artifact they describe.

Two root causes, both in agent/conformance.py:

1. Evidence has no syntactic role. The search is a regex over raw lines, so a comment, a
   docstring or a Jest test title matches a declaration pattern just as well as a real
   declaration does. After the only real `class Game` is deleted, the element still scores
   `implemented` on the strength of a comment in shared/src/domain/index.js and the test
   title `describe('Game (ClassDiagram: class Game)')`.
2. Method credit is project-global. `decl_files` is computed at conformance.py:137 and then
   never used, so a method counts as found if its name occurs anywhere in the project -
   including in the docstring that merely restates the spec.

The earlier META_FILES fix (excluding spec.json and the run transcript by filename) removed
the one instance that had been observed; it did not address the general case.

Run:  python experiments/mutation_experiment.py
"""
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from agent.conformance import check_conformance
from agent.tools import Workspace
from agent.uml_parse import merge_diagrams

SRC = REPO / "generated-project"
IGNORE = shutil.ignore_patterns("node_modules", ".git", "dist-desktop", "coverage")
INFRA = ["GameServer", "QuestionServer", "UserClient", "AdminClient",
         "GameContainer", "QuestionContainer", "UserContainer", "AdminContainer"]


def _run(root):
    spec = json.loads((SRC / "spec.json").read_text(encoding="utf-8"))
    diagram = merge_diagrams([d["plantuml"] for d in spec["views"]["diagrams"]])
    report = check_conformance(diagram, Workspace(root))
    return (report,
            {e.name: e for e in report.elements},
            {(r.a, r.b): r.status for r in report.relationships})


def _method_found(elements, cls, method):
    element = elements.get(cls)
    return bool(element and method in element.methods_found)


def main():
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)

        def fresh(name):
            dest = scratch / name
            shutil.copytree(SRC, dest, ignore=IGNORE)
            return dest

        report, elements, _ = _run(fresh("baseline"))
        rows.append(("baseline (untouched)", report, "-"))

        # The specified class is no longer declared anywhere in real source.
        root = fresh("no_class_decl")
        path = root / "services/game/src/domain/game.js"
        text = path.read_text(encoding="utf-8")
        mutated = re.sub(r"(?m)^class Game \{", "class GameLegacyHolder {", text)
        assert mutated != text and not re.search(r"(?m)^class Game\b", mutated)
        path.write_text(mutated, encoding="utf-8")
        report, elements, _ = _run(root)
        rows.append(("real `class Game` declaration deleted", report,
                     f"Game -> {elements['Game'].status}"))

        # The specified method is no longer implemented; its UML docstring remains.
        root = fresh("no_method_body")
        path = root / "services/game/src/domain/game.js"
        text = path.read_text(encoding="utf-8")
        mutated = re.sub(r"(?m)^  play\(\) \{", "  playRenamedAway() {", text)
        assert mutated != text and not re.search(r"(?m)^  play\(\) \{", mutated)
        path.write_text(mutated, encoding="utf-8")
        report, elements, _ = _run(root)
        rows.append(("real Game.play() body deleted", report,
                     f"play -> {'found' if _method_found(elements, 'Game', 'play') else 'missing'}"))

        # Annotations survive, but no longer annotate anything: moved to a flat list.
        root = fresh("annotations_relocated")
        path = root / "docker-compose.yml"
        keep, moved = [], []
        for line in path.read_text(encoding="utf-8").splitlines():
            (moved if "Architecture Node:" in line or "Architecture Artifact:" in line else keep).append(line)
        assert len(moved) == 8, f"expected 8 annotations, found {len(moved)}"
        path.write_text("\n".join(keep), encoding="utf-8")
        (root / "architecture-notes.md").write_text(
            "Deployment notes\n\n" + "\n".join(x.strip() for x in moved) + "\n", encoding="utf-8")
        report, elements, relationships = _run(root)
        infra_rels = [k for k in relationships if k[0] in INFRA and k[1] in INFRA]
        rows.append((f"all {len(moved)} infra annotations moved to a flat .md list", report,
                     f"{sum(elements[n].status == 'implemented' for n in INFRA)}/8 infra implemented, "
                     f"{sum(relationships[k] == 'found' for k in infra_rels)}/{len(infra_rels)} rels found"))

        # The deployment artifact itself is gone; only the flat annotation list remains.
        root = fresh("compose_deleted")
        path = root / "docker-compose.yml"
        moved = [l for l in path.read_text(encoding="utf-8").splitlines()
                 if "Architecture Node:" in l or "Architecture Artifact:" in l]
        path.unlink()
        (root / "architecture-notes.md").write_text(
            "Deployment notes\n\n" + "\n".join(x.strip() for x in moved) + "\n", encoding="utf-8")
        assert not path.exists()
        report, elements, relationships = _run(root)
        infra_rels = [k for k in relationships if k[0] in INFRA and k[1] in INFRA]
        rows.append(("docker-compose.yml deleted entirely", report,
                     f"{sum(elements[n].status == 'implemented' for n in INFRA)}/8 infra implemented, "
                     f"{sum(relationships[k] == 'found' for k in infra_rels)}/{len(infra_rels)} rels found"))

        # Control: a pure comment edit, which changes no behaviour whatsoever.
        root = fresh("one_annotation_removed")
        path = root / "docker-compose.yml"
        mutated = "\n".join(l for l in path.read_text(encoding="utf-8").splitlines()
                            if "Architecture Node: GameServer" not in l)
        assert "Architecture Node: GameServer" not in mutated
        path.write_text(mutated, encoding="utf-8")
        report, elements, _ = _run(root)
        rows.append(("one annotation *comment* deleted (no behaviour change)", report,
                     f"GameServer -> {elements['GameServer'].status}"))

    width = max(len(name) for name, _, _ in rows)
    print(f"\n{'scenario':<{width}}  {'strict':>6} {'lenient':>8}   detail")
    print("-" * (width + 40))
    for name, report, detail in rows:
        print(f"{name:<{width}}  {report.strict_score:>5.0%} {report.lenient_score:>8.0%}   {detail}")
    print()


if __name__ == "__main__":
    main()
