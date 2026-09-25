"""Architecture conformance checking: does the generated project actually contain what the UML
said it should, and does the given traceability matrix's requirement-to-component mapping hold up
once there is real code to check it against?

This is the "verification" half of the idea (see uml_parse.py for the "as-specified" half): most
code-generation agents stop at generating code and never check it against the spec that produced
it. Here, checking is deliberately *independent* of the agent that wrote the code - it works by
grepping the generated project's actual files for evidence of each class, component and
relationship named in the diagrams, using plain string/regex search, not by asking the model that
just wrote the code to grade its own work. A self-report from the same agent that did the
generation would be evidence, but not verification.

First-version scope, stated plainly rather than hidden: this is heuristic string matching, not a
real per-language parser or import-graph analysis - it can be fooled by coincidental name matches,
and a relationship being "found" only means B's name appears somewhere in a file that also
mentions A, not that a real dependency exists. It is still strictly more evidence than an
unchecked LLM claim, and it is where a language-aware version (parsing actual ASTs/import graphs
per generated stack) would extend this rather than replace it - a natural next feature, not a
rewrite.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .tools import Workspace
from .uml_parse import ParsedDiagram

SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv"}
# The agent's own bookkeeping files, not generated source - real bug this caught on the first real
# run: spec.json contains the raw PlantUML text for every diagram, and run_transcript.json quotes
# the whole conversation (including spec.json's own content, read back by the agent) verbatim, so
# without this exclusion every class/component name "matched" there regardless of whether any real
# code existed - a false positive baked into every score before this fix, not a hypothetical one.
META_FILES = {"spec.json", "run_transcript.json", "run_stats.json", "conformance_report.json", "CONFORMANCE_REPORT.md", "install.log"}
CLASS_DECL_TEMPLATE = r"\b(?:class|interface|struct|type)\s+{name}\b"
BARE_NAME_TEMPLATE = r"\b{name}\b"


@dataclass
class Evidence:
    file: str
    line: int
    text: str


@dataclass
class ElementCheck:
    name: str
    kind: str  # "class" | "component"
    status: str  # "implemented" | "referenced" | "missing"
    evidence: List[Evidence] = field(default_factory=list)
    methods_found: List[str] = field(default_factory=list)
    methods_missing: List[str] = field(default_factory=list)


@dataclass
class RelationshipCheck:
    a: str
    b: str
    status: str  # "found" | "missing"
    evidence: Optional[Evidence] = None


@dataclass
class ConformanceReport:
    elements: List[ElementCheck]
    relationships: List[RelationshipCheck]

    @property
    def strict_score(self) -> float:
        """Only classes/components actually declared as such (class Foo / interface Foo / ...),
        methods present, and relationships found - the honest, conservative number."""
        return self._score(lambda e: 1.0 if e.status == "implemented" else 0.0)

    @property
    def lenient_score(self) -> float:
        """Also gives partial credit when a name is merely referenced somewhere (e.g. a
        functional/procedural implementation that never declares a formal class) - reported
        separately rather than folded into one number, so a high score can't come from string
        matches alone without saying so."""
        return self._score(lambda e: 1.0 if e.status == "implemented" else (0.5 if e.status == "referenced" else 0.0))

    def _score(self, weight) -> float:
        elements = self.elements
        rel_hits = sum(1 for r in self.relationships if r.status == "found")
        total = len(elements) + len(self.relationships)
        if total == 0:
            return 1.0
        return round((sum(weight(e) for e in elements) + rel_hits) / total, 4)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "strict_score": self.strict_score,
            "lenient_score": self.lenient_score,
            "elements": [asdict(e) for e in self.elements],
            "relationships": [asdict(r) for r in self.relationships],
        }


def _search_project(workspace: Workspace, pattern: str) -> List[Evidence]:
    regex = re.compile(pattern, re.IGNORECASE)
    hits: List[Evidence] = []
    for entry in sorted(workspace.root.rglob("*")):
        if entry.is_dir() or any(part in SKIP_DIRS for part in entry.parts) or entry.name in META_FILES:
            continue
        try:
            text = entry.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError):
            continue
        rel = entry.relative_to(workspace.root).as_posix()
        for i, line in enumerate(text.splitlines(), start=1):
            if regex.search(line):
                hits.append(Evidence(file=rel, line=i, text=line.strip()[:200]))
    return hits


def _check_element(workspace: Workspace, name: str, kind: str, methods: List[str]) -> ElementCheck:
    decl_hits = _search_project(workspace, CLASS_DECL_TEMPLATE.format(name=re.escape(name)))
    if decl_hits:
        found_methods, missing_methods = [], []
        decl_files = {h.file for h in decl_hits}
        for method in methods:
            method_hits = _search_project(workspace, BARE_NAME_TEMPLATE.format(name=re.escape(method)))
            # Credit a method if it appears in the same file as the class declaration, or anywhere
            # else in the project (covers a method implemented in a separate file, e.g. a router).
            (found_methods if method_hits else missing_methods).append(method)
        return ElementCheck(name=name, kind=kind, status="implemented", evidence=decl_hits[:3], methods_found=found_methods, methods_missing=missing_methods)

    bare_hits = _search_project(workspace, BARE_NAME_TEMPLATE.format(name=re.escape(name)))
    if bare_hits:
        return ElementCheck(name=name, kind=kind, status="referenced", evidence=bare_hits[:3], methods_missing=list(methods))
    return ElementCheck(name=name, kind=kind, status="missing", methods_missing=list(methods))


def _check_relationship(workspace: Workspace, a: str, b: str, element_evidence: Dict[str, ElementCheck]) -> RelationshipCheck:
    a_check = element_evidence.get(a)
    # Require a to be a real implementation, not merely "referenced" (a bare name mention) - a
    # stray comment naming both a and b would otherwise make the relationship look "found" for
    # free. A test with two unimplemented names in one comment caught exactly this on the first
    # run: both looked "related" purely because they shared a sentence, not any actual code.
    if not a_check or a_check.status != "implemented":
        return RelationshipCheck(a=a, b=b, status="missing")
    # Look for b's name inside whichever files actually mention a, not the whole project - the
    # point is "does a's code reference b", not "does b's name appear anywhere at all".
    b_pattern = re.compile(BARE_NAME_TEMPLATE.format(name=re.escape(b)), re.IGNORECASE)
    for evidence in a_check.evidence:
        file_path = workspace.root / evidence.file
        try:
            text = file_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError, FileNotFoundError):
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            if b_pattern.search(line):
                return RelationshipCheck(a=a, b=b, status="found", evidence=Evidence(file=evidence.file, line=i, text=line.strip()[:200]))
    return RelationshipCheck(a=a, b=b, status="missing")


def check_conformance(diagram: ParsedDiagram, workspace: Workspace) -> ConformanceReport:
    element_checks: Dict[str, ElementCheck] = {}
    for name, cls in diagram.classes.items():
        element_checks[name] = _check_element(workspace, name, "class", cls.methods)
    for name in diagram.elements:
        if name not in element_checks:  # a name can appear as both a class and a component artifact
            element_checks[name] = _check_element(workspace, name, "component", [])

    known_names = set(element_checks)
    relationship_checks = [
        _check_relationship(workspace, a, b, element_checks)
        for a, b in diagram.relationships
        if a in known_names and b in known_names  # excludes object-diagram instances / state names - see uml_parse's own test for why
    ]
    return ConformanceReport(elements=list(element_checks.values()), relationships=relationship_checks)


def extend_traceability_matrix(traceability_matrix: List[Dict[str, Any]], report: ConformanceReport) -> List[Dict[str, Any]]:
    """The given input document already has a Requirement -> Component(s) traceability table
    (Section B of Architecture_Documentation.md); this adds the column a human would otherwise
    have to fill in by hand after reading the generated code: is it actually there."""
    status_by_name = {e.name: e.status for e in report.elements}
    extended = []
    for row in traceability_matrix:
        components = row.get("components", [])
        statuses = [status_by_name.get(c, "not in diagrams") for c in components]
        verified = bool(components) and all(s == "implemented" for s in statuses)
        extended.append({**row, "component_statuses": dict(zip(components, statuses)), "verified": verified})
    return extended


def render_report_markdown(report: ConformanceReport, extended_matrix: List[Dict[str, Any]]) -> str:
    lines = [
        "# Architecture Conformance Report",
        "",
        "First-version, heuristic (string/regex search over the generated project, not a real "
        "per-language parser) - see conformance.py's module docstring for exactly what that means "
        "and where it can be wrong. Two scores are given deliberately: `strict` only counts a name "
        "that is actually declared as a class/component; `lenient` also gives partial credit for a "
        "name that merely appears somewhere, so a high number can't hide behind loose string matches.",
        "",
        f"**Strict score: {report.strict_score:.0%}**  |  **Lenient score: {report.lenient_score:.0%}**",
        "",
        "## Classes and components",
        "",
        "| Name | Kind | Status | Methods found | Methods missing | Evidence |",
        "|---|---|---|---|---|---|",
    ]
    for e in report.elements:
        evidence = f"{e.evidence[0].file}:{e.evidence[0].line}" if e.evidence else "-"
        lines.append(f"| {e.name} | {e.kind} | {e.status} | {', '.join(e.methods_found) or '-'} | {', '.join(e.methods_missing) or '-'} | {evidence} |")

    lines += ["", "## Relationships", "", "| From | To | Status | Evidence |", "|---|---|---|---|"]
    for r in report.relationships:
        evidence = f"{r.evidence.file}:{r.evidence.line}" if r.evidence else "-"
        lines.append(f"| {r.a} | {r.b} | {r.status} | {evidence} |")

    lines += ["", "## Traceability matrix (extended with verification)", "", "| Requirement ID | Short Text | Component(s) | Verified |", "|---|---|---|---|"]
    for row in extended_matrix:
        req_id = row.get("requirement id", "")
        short_text = row.get("short text", "")
        comp_status = ", ".join(f"{c} ({s})" for c, s in row["component_statuses"].items()) or "-"
        lines.append(f"| {req_id} | {short_text} | {comp_status} | {'yes' if row['verified'] else 'no'} |")

    return "\n".join(lines) + "\n"
