"""Mermaid renderability validation.

Goes beyond basic syntax checks to verify structural validity:
  - directive present and recognized
  - bracket/brace/parenthesis balance
  - subgraph/end balance
  - node ID validity
  - edge syntax correctness
  - no orphan references
  - sequence diagram participant/actor consistency
  - state diagram state declaration consistency

Returns structured errors that the repair engine can act on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .mermaid_syntax import classify, validate_basic, DiagramType
from .stage_contracts import RenderStatus, RenderValidationResult


_NODE_ID_RE = re.compile(r"\b([a-zA-Z_]\w*)\s*[\[\({]")
_EDGE_RE = re.compile(
    r"(\w+)\s*(?:-->|==>|-.->|--\>|--x|--o|->>|-->>|<<-->>|~~~)\s*(?:\|[^|]*\|)?\s*(\w+)"
)
_SUBGRAPH_OPEN_RE = re.compile(r"^\s*subgraph\s+(\w+)", re.MULTILINE)
_SUBGRAPH_END_RE = re.compile(r"^\s*end\s*$", re.MULTILINE)

_SEQ_PARTICIPANT_RE = re.compile(r"^\s*(?:participant|actor)\s+(\w+)", re.MULTILINE)
_SEQ_MESSAGE_RE = re.compile(r"(\w+)\s*->>?\+?\s*(\w+)\s*:", re.MULTILINE)

_STATE_DECL_RE = re.compile(r"^\s*state\s+\"?([^\"]+)\"?\s+as\s+(\w+)", re.MULTILINE)
_STATE_TRANSITION_RE = re.compile(r"(\w+|\[\*\])\s*-->\s*(\w+|\[\*\])")


def validate(source: str) -> RenderValidationResult:
    """Full renderability validation of Mermaid source."""
    if not source or not source.strip():
        return RenderValidationResult(
            status=RenderStatus.INVALID_SYNTAX,
            is_renderable=False,
            errors=["Empty source"],
        )

    errors: list[str] = []
    warnings: list[str] = []
    error_lines: list[int] = []

    basic_warnings = validate_basic(source)
    for w in basic_warnings:
        if "Empty source" in w or "Could not detect" in w:
            errors.append(w)
        else:
            warnings.append(w)

    diagram_type = classify(source)
    if diagram_type == "unknown":
        errors.append("No recognized Mermaid directive found")
        _find_directive_error_line(source, error_lines)

    _validate_bracket_balance(source, errors)
    _validate_subgraph_balance(source, errors, error_lines)

    if diagram_type == "flowchart":
        _validate_flowchart(source, errors, warnings, error_lines)
    elif diagram_type == "sequence":
        _validate_sequence(source, errors, warnings, error_lines)
    elif diagram_type == "state":
        _validate_state(source, errors, warnings, error_lines)

    _validate_common_mistakes(source, errors, error_lines)

    if errors:
        return RenderValidationResult(
            status=RenderStatus.INVALID_SYNTAX,
            is_renderable=False,
            errors=errors,
            warnings=warnings,
            error_lines=error_lines,
        )

    return RenderValidationResult(
        status=RenderStatus.VALID,
        is_renderable=True,
        errors=[],
        warnings=warnings,
        error_lines=[],
    )


def _find_directive_error_line(source: str, error_lines: list[int]) -> None:
    for i, line in enumerate(source.splitlines(), 1):
        stripped = line.strip()
        if stripped and not stripped.startswith("%%") and not stripped.startswith("classDef"):
            error_lines.append(i)
            break


def _validate_bracket_balance(source: str, errors: list[str]) -> None:
    pairs = [("{", "}", "curly braces"), ("[", "]", "square brackets"), ("(", ")", "parentheses")]
    for open_ch, close_ch, name in pairs:
        opens = source.count(open_ch)
        closes = source.count(close_ch)
        if opens != closes:
            errors.append(f"Unbalanced {name}: {opens} open, {closes} close")


def _validate_subgraph_balance(
    source: str, errors: list[str], error_lines: list[int]
) -> None:
    opens = len(_SUBGRAPH_OPEN_RE.findall(source))
    closes = len(_SUBGRAPH_END_RE.findall(source))
    if opens != closes:
        errors.append(f"subgraph/end imbalance: {opens} subgraph, {closes} end")
        for i, line in enumerate(source.splitlines(), 1):
            if re.match(r"^\s*subgraph\b", line):
                error_lines.append(i)


def _validate_flowchart(
    source: str, errors: list[str], warnings: list[str],
    error_lines: list[int],
) -> None:
    declared_nodes: set[str] = set()
    for m in _NODE_ID_RE.finditer(source):
        declared_nodes.add(m.group(1))

    edge_nodes: set[str] = set()
    for m in _EDGE_RE.finditer(source):
        edge_nodes.add(m.group(1))
        edge_nodes.add(m.group(2))

    subgraph_ids = set(_SUBGRAPH_OPEN_RE.findall(source))

    directive_words = {"flowchart", "graph", "LR", "RL", "TB", "TD", "BT"}
    keywords = {"end", "subgraph", "classDef", "class", "click", "style", "linkStyle"}

    referenced_but_undeclared = edge_nodes - declared_nodes - subgraph_ids - directive_words - keywords
    if referenced_but_undeclared:
        for node_id in list(referenced_but_undeclared)[:5]:
            if len(node_id) > 1 and not node_id.startswith("_"):
                warnings.append(f"Node '{node_id}' used in edge but never declared with label")


def _validate_sequence(
    source: str, errors: list[str], warnings: list[str],
    error_lines: list[int],
) -> None:
    declared = set(_SEQ_PARTICIPANT_RE.findall(source))
    used: set[str] = set()
    for m in _SEQ_MESSAGE_RE.finditer(source):
        used.add(m.group(1))
        used.add(m.group(2))

    undeclared = used - declared
    if undeclared and declared:
        for p in list(undeclared)[:3]:
            warnings.append(f"Participant '{p}' used in messages but not declared")


def _validate_state(
    source: str, errors: list[str], warnings: list[str],
    error_lines: list[int],
) -> None:
    declared_states: set[str] = set()
    for m in _STATE_DECL_RE.finditer(source):
        declared_states.add(m.group(2))

    transition_states: set[str] = set()
    for m in _STATE_TRANSITION_RE.finditer(source):
        if m.group(1) != "[*]":
            transition_states.add(m.group(1))
        if m.group(2) != "[*]":
            transition_states.add(m.group(2))

    if declared_states:
        undeclared = transition_states - declared_states
        for s in list(undeclared)[:3]:
            warnings.append(f"State '{s}' used in transition but not declared")


def _validate_common_mistakes(
    source: str, errors: list[str], error_lines: list[int]
) -> None:
    for i, line in enumerate(source.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("```"):
            errors.append(f"Line {i}: Markdown code fence found inside Mermaid source")
            error_lines.append(i)
        if "–>" in stripped or "—>" in stripped:
            errors.append(f"Line {i}: Unicode dash in arrow (use --> not –> or —>)")
            error_lines.append(i)
        if re.search(r'"\s*\].*\[', stripped):
            errors.append(f"Line {i}: Possible malformed node declaration")
            error_lines.append(i)
