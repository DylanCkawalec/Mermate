"""Mermaid syntax rules, validation, and diagram type classification."""

from __future__ import annotations

import re
from typing import Literal

DiagramType = Literal[
    "flowchart", "sequence", "class", "state", "er", "gantt", "pie",
    "gitgraph", "mindmap", "timeline", "journey", "c4", "quadrant",
    "requirement", "sankey", "xychart", "block", "unknown",
]

_DIRECTIVE_MAP: list[tuple[re.Pattern, DiagramType]] = [
    (re.compile(r"^flowchart\b", re.IGNORECASE), "flowchart"),
    (re.compile(r"^graph\b", re.IGNORECASE), "flowchart"),
    (re.compile(r"^sequenceDiagram\b"), "sequence"),
    (re.compile(r"^classDiagram\b"), "class"),
    (re.compile(r"^stateDiagram\b"), "state"),
    (re.compile(r"^erDiagram\b"), "er"),
    (re.compile(r"^gantt\b"), "gantt"),
    (re.compile(r"^pie\b"), "pie"),
    (re.compile(r"^gitgraph\b"), "gitgraph"),
    (re.compile(r"^mindmap\b"), "mindmap"),
    (re.compile(r"^timeline\b"), "timeline"),
    (re.compile(r"^journey\b"), "journey"),
    (re.compile(r"^C4Context\b"), "c4"),
    (re.compile(r"^C4Container\b"), "c4"),
    (re.compile(r"^C4Component\b"), "c4"),
    (re.compile(r"^C4Dynamic\b"), "c4"),
    (re.compile(r"^quadrantChart\b"), "quadrant"),
    (re.compile(r"^requirementDiagram\b"), "requirement"),
    (re.compile(r"^sankey-beta\b"), "sankey"),
    (re.compile(r"^xychart-beta\b"), "xychart"),
    (re.compile(r"^block-beta\b"), "block"),
]


def classify(source: str) -> DiagramType:
    """Classify Mermaid source into its diagram type."""
    if not source:
        return "unknown"
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("%%") or line.startswith("classDef "):
            continue
        for pattern, dtype in _DIRECTIVE_MAP:
            if pattern.search(line):
                return dtype
        return "unknown"
    return "unknown"


def validate_basic(source: str) -> list[str]:
    """Run lightweight syntax checks. Returns a list of warning strings."""
    warnings: list[str] = []
    if not source or not source.strip():
        warnings.append("Empty source")
        return warnings

    dtype = classify(source)
    if dtype == "unknown":
        warnings.append("Could not detect diagram type from first directive")

    # Check balanced brackets
    for ch_open, ch_close, name in [("{", "}", "curly braces"), ("[", "]", "square brackets"), ("(", ")", "parentheses")]:
        if source.count(ch_open) != source.count(ch_close):
            warnings.append(f"Unbalanced {name}: {source.count(ch_open)} open vs {source.count(ch_close)} close")

    return warnings


def score_formatting(source: str) -> int:
    """Score formatting quality 0-100.

    Evaluates: indentation consistency, bracket balance, directive
    canonicalization, trailing whitespace, blank line discipline,
    and structural organization.
    """
    if not source or not source.strip():
        return 0

    score = 100
    lines = source.splitlines()
    deductions: list[str] = []  # noqa: F841 — kept for debugging

    # --- Trailing whitespace (up to -15) ---
    trailing_ws = sum(1 for ln in lines if ln != ln.rstrip())
    if trailing_ws:
        penalty = min(15, trailing_ws * 3)
        score -= penalty

    # --- Indentation consistency (up to -25) ---
    indent_sizes: list[int] = []
    for ln in lines:
        stripped = ln.lstrip()
        if not stripped or stripped.startswith("%%"):
            continue
        leading = len(ln) - len(stripped)
        if leading > 0:
            indent_sizes.append(leading)
    if indent_sizes:
        # Check if all non-zero indents are multiples of 2
        non_canonical = sum(1 for s in indent_sizes if s % 2 != 0)
        if non_canonical:
            score -= min(25, non_canonical * 5)
        # Check if indents use tabs
        if any("\t" in ln for ln in lines):
            score -= 10

    # --- Directive canonicalization (up to -10) ---
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("%%") or line.startswith("classDef "):
            continue
        if re.match(r"^graph\b", line, re.IGNORECASE):
            score -= 10  # should be 'flowchart'
        break

    # --- Excessive blank lines (up to -10) ---
    consecutive_blanks = 0
    max_blanks = 0
    for ln in lines:
        if not ln.strip():
            consecutive_blanks += 1
            max_blanks = max(max_blanks, consecutive_blanks)
        else:
            consecutive_blanks = 0
    if max_blanks > 2:
        score -= min(10, (max_blanks - 2) * 3)

    # --- Bracket balance (up to -20) ---
    for ch_o, ch_c in [("{", "}"), ("[", "]"), ("(", ")")]:
        if source.count(ch_o) != source.count(ch_c):
            score -= 10

    # --- classDef ordering (-10 if classDefs appear after nodes/edges) ---
    seen_non_classdef_content = False
    classdef_after_content = False
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("%%"):
            continue
        if classify(source) == "flowchart" and re.match(r"^(flowchart|graph)\b", line, re.IGNORECASE):
            continue
        if line.startswith("classDef "):
            if seen_non_classdef_content:
                classdef_after_content = True
            continue
        if line.startswith("class ") and " " in line[6:]:
            continue  # class assignment, not content
        seen_non_classdef_content = True
    if classdef_after_content:
        score -= 10

    return max(0, min(100, score))
