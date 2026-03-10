"""Deterministic OODA pipeline for Mermaid diagram enhancement.

Observe → Orient → Decide → Act

This module operates purely on text — no LLM calls. The LLM-assisted
refinement is handled by enhancer_service.py when available.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from .mermaid_syntax import classify, validate_basic, score_formatting, DiagramType


TransformStrategy = Literal["passthrough", "normalize", "refine", "restructure"]


@dataclass
class Observation:
    """Result of the Observe phase."""
    raw_source: str
    line_count: int
    node_count: int
    edge_count: int
    subgraph_count: int
    has_class_defs: bool
    has_emojis: bool
    formatting_score: int = 100
    warnings: list[str] = field(default_factory=list)


@dataclass
class Orientation:
    """Result of the Orient phase."""
    diagram_type: DiagramType
    complexity: Literal["simple", "moderate", "complex"]
    structural_intent: str


@dataclass
class Decision:
    """Result of the Decide phase."""
    strategy: TransformStrategy
    apply_aad_formatting: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class OODAResult:
    """Full pipeline result."""
    observation: Observation
    orientation: Orientation
    decision: Decision
    output_source: str
    transformation_log: list[str] = field(default_factory=list)


def observe(source: str) -> Observation:
    """Inspect raw source and extract structural metadata."""
    lines = source.splitlines()
    node_pattern = re.compile(r"\b\w+\[")
    edge_pattern = re.compile(r"-->|==>|-.->|--\>|--x|--o|\|\|--")
    subgraph_pattern = re.compile(r"^\s*subgraph\b", re.MULTILINE)
    emoji_pattern = re.compile(r"[\U0001F300-\U0001FAFF]")

    return Observation(
        raw_source=source,
        line_count=len(lines),
        node_count=len(node_pattern.findall(source)),
        edge_count=len(edge_pattern.findall(source)),
        subgraph_count=len(subgraph_pattern.findall(source)),
        has_class_defs="classDef " in source,
        has_emojis=bool(emoji_pattern.search(source)),
        formatting_score=score_formatting(source),
        warnings=validate_basic(source),
    )


def orient(obs: Observation) -> Orientation:
    """Classify and assess the diagram."""
    dtype = classify(obs.raw_source)

    # Complexity heuristic
    total_elements = obs.node_count + obs.edge_count + obs.subgraph_count
    if total_elements > 40 or obs.line_count > 80:
        complexity = "complex"
    elif total_elements > 15 or obs.line_count > 30:
        complexity = "moderate"
    else:
        complexity = "simple"

    # Structural intent
    if obs.subgraph_count > 2:
        intent = "architecture diagram with layered subsystems"
    elif dtype == "sequence":
        intent = "interaction/communication flow"
    elif dtype == "er":
        intent = "data model / entity relationships"
    elif dtype in ("gantt", "timeline"):
        intent = "temporal / scheduling visualization"
    else:
        intent = "general diagram"

    return Orientation(
        diagram_type=dtype,
        complexity=complexity,
        structural_intent=intent,
    )


def decide(obs: Observation, ori: Orientation) -> Decision:
    """Select transformation strategy based on formatting score."""
    reasons: list[str] = []
    score = obs.formatting_score

    # Complex diagrams with classDefs benefit from AAD formatting
    apply_aad = ori.complexity == "complex" and obs.has_class_defs
    if apply_aad:
        reasons.append("Complex diagram with classDefs — AAD formatting applicable")

    # Strategy selection based on formatting score
    if score >= 90 and not obs.warnings and ori.complexity == "simple":
        strategy: TransformStrategy = "passthrough"
        reasons.append(f"Score {score}/100 — clean input, no changes needed")
    elif score >= 60 or obs.warnings:
        strategy = "normalize"
        reasons.append(f"Score {score}/100 — normalization pass needed")
        if obs.warnings:
            reasons.append(f"{len(obs.warnings)} syntax warning(s)")
    elif score >= 30:
        strategy = "refine"
        reasons.append(f"Score {score}/100 — deeper refinement needed")
    else:
        # Score < 30 — would need restructure, but we cap at refine
        # (restructure reserved for future LLM-assisted path)
        strategy = "refine"
        reasons.append(f"Score {score}/100 — significant formatting issues")

    return Decision(strategy=strategy, apply_aad_formatting=apply_aad, reasons=reasons)


def _strip_trailing_whitespace(lines: list[str], log: list[str]) -> list[str]:
    """Strip trailing whitespace from all lines."""
    cleaned = [ln.rstrip() for ln in lines]
    if cleaned != lines:
        log.append("Stripped trailing whitespace")
    return cleaned


def _normalize_indentation(lines: list[str], log: list[str]) -> list[str]:
    """Normalize indentation to 2-space multiples."""
    result = []
    changed = False
    for ln in lines:
        stripped = ln.lstrip()
        if not stripped:
            result.append("")
            continue
        leading = len(ln) - len(stripped)
        if leading > 0 and "\t" in ln[:leading]:
            # Convert tabs to 2-space
            new_indent = ln[:leading].replace("\t", "  ")
            result.append(new_indent + stripped)
            changed = True
        else:
            result.append(ln)
    if changed:
        log.append("Converted tab indentation to spaces")
    return result


def _collapse_blank_lines(lines: list[str], log: list[str]) -> list[str]:
    """Collapse 3+ consecutive blank lines to 2."""
    result: list[str] = []
    blank_count = 0
    collapsed = False
    for ln in lines:
        if not ln.strip():
            blank_count += 1
            if blank_count <= 2:
                result.append(ln)
            else:
                collapsed = True
        else:
            blank_count = 0
            result.append(ln)
    if collapsed:
        log.append("Collapsed excessive blank lines")
    return result


def _canonicalize_directive(lines: list[str], log: list[str]) -> list[str]:
    """Replace `graph XX` with `flowchart XX` (canonical form)."""
    result = []
    for ln in lines:
        stripped = ln.strip()
        if not stripped or stripped.startswith("%%") or stripped.startswith("classDef "):
            result.append(ln)
            continue
        # Only replace the first directive line
        m = re.match(r"^(\s*)graph\b(.*)$", ln, re.IGNORECASE)
        if m:
            result.append(f"{m.group(1)}flowchart{m.group(2)}")
            log.append(f"Canonicalized directive: graph → flowchart")
            result.extend(lines[len(result):])
            return result
        result.append(ln)
        # First non-comment, non-empty line that wasn't graph — stop checking
        break
    result.extend(lines[len(result):])
    return result


def _reorder_classdefs(lines: list[str], log: list[str]) -> list[str]:
    """Move classDef declarations to immediately after the directive line."""
    directive_idx = -1
    classdef_lines: list[str] = []
    other_lines: list[str] = []
    class_assignment_lines: list[str] = []

    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if directive_idx == -1:
            other_lines.append(ln)
            if stripped and not stripped.startswith("%%") and not stripped.startswith("classDef "):
                directive_idx = i
            elif stripped.startswith("classDef "):
                # classDef before directive — already at top, leave as-is
                classdef_lines.append(ln)
            continue
        if stripped.startswith("classDef "):
            classdef_lines.append(ln)
        elif re.match(r"^class\s+\w+\s+\w+", stripped):
            class_assignment_lines.append(ln)
        else:
            other_lines.append(ln)

    if not classdef_lines:
        return lines  # nothing to reorder

    # Insert classDefs right after directive, then class assignments at end
    result: list[str] = []
    inserted = False
    for i, ln in enumerate(other_lines):
        result.append(ln)
        if i == directive_idx and not inserted:
            result.append("")  # blank separator
            result.extend(classdef_lines)
            inserted = True

    if class_assignment_lines:
        result.extend(class_assignment_lines)

    if inserted and classdef_lines:
        log.append(f"Reordered {len(classdef_lines)} classDef(s) to top")
    return result


def _ensure_subgraph_balance(lines: list[str], log: list[str]) -> list[str]:
    """Check subgraph/end balance and warn (do not auto-fix — intent preservation)."""
    opens = sum(1 for ln in lines if re.match(r"^\s*subgraph\b", ln))
    closes = sum(1 for ln in lines if ln.strip() == "end")
    if opens != closes:
        log.append(f"Warning: subgraph/end imbalance ({opens} subgraph vs {closes} end)")
    return lines


def act(source: str, decision: Decision) -> tuple[str, list[str]]:
    """Apply the decided transformation. Returns (output_source, log)."""
    log: list[str] = []

    if decision.strategy == "passthrough":
        log.append("Passthrough: no modifications applied")
        return source, log

    lines = source.splitlines()

    # All strategies: strip trailing whitespace + normalize indentation + collapse blanks
    lines = _strip_trailing_whitespace(lines, log)
    lines = _normalize_indentation(lines, log)
    lines = _collapse_blank_lines(lines, log)

    # Refine strategy: also canonicalize directive + reorder classDefs
    if decision.strategy in ("refine", "restructure"):
        lines = _canonicalize_directive(lines, log)
        lines = _reorder_classdefs(lines, log)

    # All strategies: check subgraph balance
    lines = _ensure_subgraph_balance(lines, log)

    # Ensure trailing newline
    output = "\n".join(lines)
    if not output.endswith("\n"):
        output += "\n"
        log.append("Added trailing newline")

    log.append(f"Strategy applied: {decision.strategy}")
    return output, log


def run_pipeline(source: str) -> OODAResult:
    """Execute the full OODA pipeline."""
    obs = observe(source)
    ori = orient(obs)
    dec = decide(obs, ori)
    output_source, transform_log = act(source, dec)

    return OODAResult(
        observation=obs,
        orientation=ori,
        decision=dec,
        output_source=output_source,
        transformation_log=transform_log,
    )
