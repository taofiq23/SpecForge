"""Parses the structural content out of PlantUML diagram source: class names with their fields
and methods, named elements (artifact/node/package), and the relationships between them.

This is the "as-specified" half of architecture conformance checking (see conformance.py): before
we can check whether the generated code matches the diagrams, we need the diagrams as data, not
text. Deterministic regex parsing, not model-driven - the spec side of a conformance check has to
be exact, or the check is comparing against a guess instead of the actual diagram.

Handles the PlantUML subset this project's own diagrams use (class bodies with `- field: type` /
`+ method(...)` lines, `artifact`/`node`/`package` declarations, and `--`, `--*`, `--o`, `-->`,
`..>`, `<|--`, `--|>` relationship arrows). It is not a general PlantUML grammar - PlantUML's real
grammar is much larger - and says so in its own limitations rather than pretending otherwise.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

CLASS_BLOCK_RE = re.compile(r"class\s+(\w+)\s*\{(.*?)\}", re.DOTALL)
FIELD_RE = re.compile(r"^\s*[-#~]\s*(\w+)\s*:", re.MULTILINE)
METHOD_RE = re.compile(r"^\s*[+#~-]\s*(\w+)\s*\(", re.MULTILINE)
ELEMENT_RE = re.compile(r"^\s*(?:artifact|node)\s+(\w+)", re.MULTILINE)
PACKAGE_RE = re.compile(r"^\s*package\s+(\w+)\s*\{(.*?)\}", re.DOTALL | re.MULTILINE)
PACKAGE_MEMBER_RE = re.compile(r"^\s*class\s+(\w+)\s*$", re.MULTILINE)
# Ordered longest-first so e.g. '--*' isn't matched as '--' with a stray '*' left over.
RELATIONSHIP_ARROWS = ["<|--", "--|>", "--*", "--o", "-->", "..>", "<--", "--"]
RELATIONSHIP_RE = re.compile(r"(\w+)\s*(" + "|".join(re.escape(a) for a in RELATIONSHIP_ARROWS) + r")\s*(\w+)")


@dataclass
class UMLClass:
    name: str
    fields: List[str] = field(default_factory=list)
    methods: List[str] = field(default_factory=list)


@dataclass
class ParsedDiagram:
    classes: Dict[str, UMLClass] = field(default_factory=dict)
    elements: List[str] = field(default_factory=list)  # artifact/node names (component/deployment diagrams)
    packages: Dict[str, List[str]] = field(default_factory=dict)  # package name -> member class names
    relationships: List[Tuple[str, str]] = field(default_factory=list)  # (a, b), direction-normalized as given


def parse_plantuml(source: str) -> ParsedDiagram:
    diagram = ParsedDiagram()

    for match in CLASS_BLOCK_RE.finditer(source):
        name, body = match.group(1), match.group(2)
        diagram.classes[name] = UMLClass(name=name, fields=FIELD_RE.findall(body), methods=METHOD_RE.findall(body))

    # Strip class bodies before scanning for bare relationships/elements, so a field or method
    # line inside a class body (e.g. "+ playGame(game: Game): void") is never mistaken for a
    # standalone relationship arrow between top-level identifiers.
    stripped = CLASS_BLOCK_RE.sub("", source)

    for match in PACKAGE_RE.finditer(source):
        pkg_name, body = match.group(1), match.group(2)
        diagram.packages[pkg_name] = PACKAGE_MEMBER_RE.findall(body)
    stripped = PACKAGE_RE.sub("", stripped)

    diagram.elements = ELEMENT_RE.findall(stripped)

    for match in RELATIONSHIP_RE.finditer(stripped):
        a, _arrow, b = match.groups()
        diagram.relationships.append((a, b))

    return diagram


def merge_diagrams(sources: List[str]) -> ParsedDiagram:
    """Combines every diagram's parse into one model - a real system's structure is scattered
    across several diagrams (a ClassDiagram for classes, a ComponentDiagram for the same
    components at a coarser grain), and conformance checking needs the union of all of it."""
    merged = ParsedDiagram()
    for source in sources:
        parsed = parse_plantuml(source)
        merged.classes.update(parsed.classes)
        merged.packages.update(parsed.packages)
        for element in parsed.elements:
            if element not in merged.elements:
                merged.elements.append(element)
        merged.relationships.extend(parsed.relationships)
    # de-duplicate relationships while preserving order
    seen = set()
    unique = []
    for rel in merged.relationships:
        if rel not in seen:
            seen.add(rel)
            unique.append(rel)
    merged.relationships = unique
    return merged
