"""No-op and false-success detection.

Catches the failure modes where the system returns a technically
successful HTTP response but the output is semantically useless:
  - unchanged text returned as "enhanced"
  - empty structured fields
  - Mermaid that is just the directive with no content
  - repetitive filler patterns
  - prose that is just the input echoed back with minor rewording

This is the last line of defense before a result is marked as success.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher


def is_noop_enhancement(original: str, enhanced: str) -> bool:
    """True if the enhancement produced no meaningful change."""
    orig = _normalize(original)
    enh = _normalize(enhanced)
    if orig == enh:
        return True
    ratio = SequenceMatcher(None, orig, enh).ratio()
    return ratio > 0.97


def is_empty_output(text: str) -> bool:
    """True if output is empty or contains only whitespace/boilerplate."""
    stripped = text.strip()
    if not stripped:
        return True
    if len(stripped) < 5:
        return True
    if stripped in ("```", "```mermaid", "```\n```", "undefined", "null", "{}"):
        return True
    return False


def is_trivial_mermaid(source: str) -> bool:
    """True if Mermaid source is just a directive with no real content."""
    lines = [l.strip() for l in source.splitlines() if l.strip()]
    content_lines = [
        l for l in lines
        if not l.startswith("%%") and not l.startswith("classDef ")
    ]
    if len(content_lines) <= 1:
        return True
    non_directive = [
        l for l in content_lines
        if not re.match(
            r"^(?:flowchart|graph|sequenceDiagram|classDiagram|"
            r"stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|"
            r"timeline|journey|C4|quadrant|requirement|sankey|xychart|block)",
            l, re.IGNORECASE,
        )
    ]
    return len(non_directive) == 0


def is_repetitive_filler(text: str) -> bool:
    """Detect repetitive low-quality suggestions."""
    filler_patterns = [
        r"^\s*->\s*\[connects?\s+to\]\s*$",
        r"^\s*\.\.\.\s*$",
        r"^\s*(?:and\s+)?then\s+(?:it\s+)?(?:connects?|sends?|goes?)\s+to\s*$",
        r"^\s*the\s+(?:system|service|component)\s+(?:connects?|sends?)\s+to\s+the\s+(?:next|other)\s+(?:system|service|component)\s*$",
    ]
    stripped = text.strip()
    for pattern in filler_patterns:
        if re.match(pattern, stripped, re.IGNORECASE):
            return True
    return False


def is_echo_back(original: str, response: str) -> bool:
    """True if the response is basically the input echoed back."""
    orig = _normalize(original)
    resp = _normalize(response)
    if orig == resp:
        return True
    if orig in resp and len(resp) < len(orig) * 1.15:
        return True
    ratio = SequenceMatcher(None, orig, resp).ratio()
    return ratio > 0.92


def validate_stage_output(
    stage: str,
    original_input: str,
    output: str,
) -> tuple[bool, str]:
    """Validate that a stage produced meaningful output.

    Returns (is_valid, reason).
    """
    if is_empty_output(output):
        return False, f"{stage}: empty output"

    if stage in ("enhance", "copilot_enhance"):
        if is_noop_enhancement(original_input, output):
            return False, f"{stage}: output unchanged from input"
        if is_echo_back(original_input, output):
            return False, f"{stage}: output is echo of input"

    if stage in ("transform", "render", "repair"):
        if is_trivial_mermaid(output):
            return False, f"{stage}: trivial Mermaid with no content"
        if not _has_mermaid_structure(output):
            return False, f"{stage}: output is not Mermaid syntax"

    if stage == "copilot_suggest":
        if is_repetitive_filler(output):
            return False, f"{stage}: repetitive filler detected"
        if len(output.strip()) < 3:
            return False, f"{stage}: suggestion too short"

    return True, "ok"


def _normalize(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^\w\s]", "", text)
    return text


def _has_mermaid_structure(text: str) -> bool:
    """Check that text contains Mermaid-like structural elements."""
    has_directive = bool(re.search(
        r"(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|"
        r"erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey|"
        r"C4|quadrant|requirement|sankey|xychart|block)",
        text, re.IGNORECASE,
    ))
    has_edges = bool(re.search(r"-->|==>|-.->|--\>|--x|--o|->>", text))
    has_nodes = bool(re.search(r"\w+\[", text))
    return has_directive and (has_edges or has_nodes)
