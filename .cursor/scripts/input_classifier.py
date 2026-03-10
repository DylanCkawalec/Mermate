"""Input classification for the gpt-oss intelligence pipeline.

Classifies raw user input along three axes:
  1. Input type (raw idea, prose, Mermaid, mixed, etc.)
  2. User intent state (brainstorming, structuring, refining, etc.)
  3. Architecture pattern and maturity

All classification is deterministic (no LLM) so it can run on every
keystroke for copilot and on every render press without latency cost.
"""

from __future__ import annotations

import re

from .mermaid_syntax import classify as classify_mermaid, validate_basic
from .semantic_analyzer import analyze as semantic_analyze
from .stage_contracts import (
    ArchitecturePattern,
    ClassificationResult,
    InputType,
    UserIntent,
)


_MERMAID_DIRECTIVE_RE = re.compile(
    r"^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|"
    r"erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey|"
    r"C4Context|C4Container|C4Component|C4Dynamic|"
    r"quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta)\b",
    re.MULTILINE | re.IGNORECASE,
)

_MERMAID_EDGE_RE = re.compile(r"-->|==>|-.->|--\>|--x|--o|->>|-->>|<<-->>")
_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_MARKDOWN_LIST_RE = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)
_MARKDOWN_CODE_FENCE_RE = re.compile(r"^```", re.MULTILINE)

_ARCH_PATTERN_MAP = {
    "microservices": ArchitecturePattern.MICROSERVICES,
    "event_driven": ArchitecturePattern.EVENT_DRIVEN,
    "layered": ArchitecturePattern.LAYERED,
    "pipeline": ArchitecturePattern.PIPELINE,
    "state_machine": ArchitecturePattern.STATE_MACHINE,
    "unknown": ArchitecturePattern.UNKNOWN,
}

_REPAIR_SIGNALS = re.compile(
    r"\b(?:(?:please\s+)?fix\b|repair\s+(?:this|the|my)|broken\s+(?:diagram|syntax|mermaid)|"
    r"invalid\s+(?:syntax|mermaid|diagram)|doesn't?\s+render|"
    r"won't?\s+compile|syntax\s+error|not\s+working|not\s+rendering)\b",
    re.IGNORECASE,
)
_VALIDATE_SIGNALS = re.compile(
    r"\b(?:check|validate|verify|correct\?|is\s+this\s+right|review)\b",
    re.IGNORECASE,
)
_FINALIZE_SIGNALS = re.compile(
    r"\b(?:final|done|complete|ready|ship|publish|render)\b",
    re.IGNORECASE,
)


def classify(text: str) -> ClassificationResult:
    """Full deterministic classification of user input."""
    stripped = text.strip()
    if not stripped:
        return ClassificationResult(
            input_type=InputType.RAW_IDEA,
            user_intent=UserIntent.BRAINSTORMING,
            architecture_pattern=ArchitecturePattern.UNKNOWN,
            maturity_score=0,
            mermaid_fraction=0.0,
            problem_statement="",
        )

    mermaid_fraction = _estimate_mermaid_fraction(stripped)
    input_type = _classify_input_type(stripped, mermaid_fraction)
    sem = semantic_analyze(stripped)
    user_intent = _classify_intent(stripped, input_type, sem.architecture.quality_score)
    arch_pattern = _ARCH_PATTERN_MAP.get(
        sem.architecture.pattern, ArchitecturePattern.UNKNOWN
    )
    maturity = _compute_maturity(stripped, input_type, sem)
    problem_stmt = _infer_problem_statement(stripped, sem)

    entities = [e.name for e in sem.entities]
    relationships = [
        f"{r.source} {r.verb} {r.target}" for r in sem.relationships
    ]

    return ClassificationResult(
        input_type=input_type,
        user_intent=user_intent,
        architecture_pattern=arch_pattern,
        maturity_score=maturity,
        mermaid_fraction=mermaid_fraction,
        problem_statement=problem_stmt,
        entities=entities,
        relationships=relationships,
    )


def _estimate_mermaid_fraction(text: str) -> float:
    lines = text.splitlines()
    if not lines:
        return 0.0
    mermaid_lines = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if _MERMAID_DIRECTIVE_RE.match(stripped):
            mermaid_lines += 1
        elif _MERMAID_EDGE_RE.search(stripped):
            mermaid_lines += 1
        elif stripped.startswith("subgraph ") or stripped == "end":
            mermaid_lines += 1
        elif stripped.startswith("classDef ") or stripped.startswith("class "):
            mermaid_lines += 1
        elif stripped.startswith("%%"):
            mermaid_lines += 1
    non_empty = sum(1 for l in lines if l.strip())
    return mermaid_lines / max(1, non_empty)


def _classify_input_type(text: str, mermaid_fraction: float) -> InputType:
    if mermaid_fraction > 0.7:
        mermaid_type = classify_mermaid(text)
        warnings = validate_basic(text)
        has_serious = any(
            "Unbalanced" in w or "Could not detect" in w for w in warnings
        )
        if mermaid_type != "unknown" and not has_serious:
            return InputType.VALID_MERMAID
        return InputType.WEAK_MERMAID

    if mermaid_fraction > 0.2:
        return InputType.MIXED_ARTIFACT

    has_headings = bool(_MARKDOWN_HEADING_RE.search(text))
    has_lists = bool(_MARKDOWN_LIST_RE.search(text))
    has_fences = bool(_MARKDOWN_CODE_FENCE_RE.search(text))
    markdown_signals = sum([has_headings, has_lists, has_fences])

    if markdown_signals >= 2:
        lines = text.splitlines()
        malformed = any(
            l.strip().startswith("#") and not re.match(r"^#{1,6}\s", l.strip())
            for l in lines
            if l.strip().startswith("#")
        )
        if malformed:
            return InputType.MALFORMED_MARKDOWN
        return InputType.MARKDOWN_SPEC

    words = text.split()
    word_count = len(words)
    sentence_count = len(re.findall(r"[.!?]+", text))

    if word_count < 15 and sentence_count <= 1:
        return InputType.RAW_IDEA

    arch_keywords = sum(
        1 for w in words
        if w.lower() in {
            "service", "database", "api", "gateway", "queue", "broker",
            "cache", "layer", "component", "module", "endpoint", "request",
            "response", "flow", "pipeline", "architecture", "system",
            "microservice", "event", "state", "interface", "protocol",
        }
    )
    keyword_density = arch_keywords / max(1, word_count)

    if keyword_density > 0.08 and sentence_count >= 3:
        return InputType.STRONG_PROSE
    if sentence_count >= 2 or word_count > 30:
        return InputType.DEVELOPING_PROSE
    return InputType.RAW_IDEA


def _classify_intent(
    text: str, input_type: InputType, quality_score: int
) -> UserIntent:
    if _REPAIR_SIGNALS.search(text):
        return UserIntent.REPAIRING
    if _VALIDATE_SIGNALS.search(text):
        return UserIntent.VALIDATING
    if _FINALIZE_SIGNALS.search(text):
        return UserIntent.FINALIZING

    if input_type in (InputType.VALID_MERMAID, InputType.WEAK_MERMAID):
        if quality_score > 60:
            return UserIntent.REFINING
        return UserIntent.REPAIRING

    if input_type == InputType.RAW_IDEA:
        return UserIntent.BRAINSTORMING
    if input_type == InputType.DEVELOPING_PROSE:
        if quality_score > 50:
            return UserIntent.STRUCTURING
        return UserIntent.BRAINSTORMING
    if input_type in (InputType.STRONG_PROSE, InputType.MARKDOWN_SPEC):
        if quality_score > 70:
            return UserIntent.FINALIZING
        return UserIntent.REFINING
    if input_type == InputType.MIXED_ARTIFACT:
        return UserIntent.STRUCTURING

    return UserIntent.BRAINSTORMING


def _compute_maturity(text: str, input_type: InputType, sem) -> int:
    """0-100 maturity score combining input type, quality, and structure."""
    base = {
        InputType.RAW_IDEA: 10,
        InputType.DEVELOPING_PROSE: 25,
        InputType.STRONG_PROSE: 50,
        InputType.MARKDOWN_SPEC: 55,
        InputType.MALFORMED_MARKDOWN: 30,
        InputType.VALID_MERMAID: 70,
        InputType.WEAK_MERMAID: 40,
        InputType.MIXED_ARTIFACT: 35,
        InputType.REFERENCE_CONTEXT: 20,
    }.get(input_type, 10)

    quality_bonus = min(30, sem.architecture.quality_score * 30 // 100)
    rel_bonus = min(10, sem.architecture.relationship_count * 2)
    entity_bonus = min(10, sem.architecture.entity_count * 2)

    return min(100, base + quality_bonus + rel_bonus + entity_bonus)


def _infer_problem_statement(text: str, sem) -> str:
    """Best-effort one-line problem statement from the input."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    if not sentences:
        return ""

    first = sentences[0].strip()
    if len(first) > 150:
        first = first[:147] + "..."

    entity_names = [e.name for e in sem.entities[:5]]
    if entity_names and sem.architecture.pattern != "unknown":
        pattern_label = sem.architecture.pattern.replace("_", " ")
        return f"{pattern_label} system with {', '.join(entity_names)}"

    return first if len(first) > 10 else text[:100].strip()
