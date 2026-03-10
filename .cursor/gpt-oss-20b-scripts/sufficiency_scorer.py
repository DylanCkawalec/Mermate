"""Architecture sufficiency and render-readiness scoring.

Evaluates user input across four dimensions:
  1. Completeness — are all necessary components present?
  2. Specificity — are entities, protocols, and technologies named?
  3. Structural quality — are relationships, flows, and layers clear?
  4. Render readiness — can this be transformed into valid Mermaid?

The scorer identifies specific gaps so the intelligence core knows
exactly what intervention is needed rather than guessing.
"""

from __future__ import annotations

from .semantic_analyzer import analyze as semantic_analyze, SemanticAnalysis
from .mermaid_syntax import classify as classify_mermaid, validate_basic
from .stage_contracts import (
    ClassificationResult,
    InputType,
    SufficiencyScore,
)


_MIN_ENTITIES_FOR_ARCHITECTURE = 2
_MIN_RELATIONSHIPS_FOR_FLOW = 1
_IDEAL_ENTITY_COUNT = 6
_IDEAL_RELATIONSHIP_COUNT = 4


def score(text: str, classification: ClassificationResult) -> SufficiencyScore:
    """Compute multi-dimensional sufficiency score for user input."""
    if not text.strip():
        return SufficiencyScore(
            completeness=0, specificity=0, structural_quality=0,
            render_readiness=0, overall=0, is_sufficient=False,
            gaps=["Empty input"],
        )

    sem = semantic_analyze(text)
    gaps: list[str] = []

    completeness = _score_completeness(text, sem, classification, gaps)
    specificity = _score_specificity(sem, gaps)
    structural = _score_structural_quality(sem, classification, gaps)
    render_ready = _score_render_readiness(text, classification, sem, gaps)

    overall = (
        completeness * 25
        + specificity * 20
        + structural * 25
        + render_ready * 30
    ) // 100

    has_critical = any(g.startswith("CRITICAL:") for g in gaps)
    is_sufficient = overall >= 70 and not has_critical
    is_render_ready = overall >= 75 and structural >= 70 and not has_critical

    return SufficiencyScore(
        completeness=completeness,
        specificity=specificity,
        structural_quality=structural,
        render_readiness=render_ready,
        overall=overall,
        is_sufficient=is_sufficient,
        is_render_ready=is_render_ready,
        gaps=gaps,
    )


def _score_completeness(
    text: str,
    sem: SemanticAnalysis,
    cls: ClassificationResult,
    gaps: list[str],
) -> int:
    score = 0
    arch = sem.architecture

    if arch.entity_count >= _IDEAL_ENTITY_COUNT:
        score += 30
    elif arch.entity_count >= _MIN_ENTITIES_FOR_ARCHITECTURE:
        score += 15 + (arch.entity_count * 3)
    elif arch.entity_count >= 1:
        score += 8
    else:
        gaps.append("No architectural entities detected")

    if arch.relationship_count >= _IDEAL_RELATIONSHIP_COUNT:
        score += 30
    elif arch.relationship_count >= _MIN_RELATIONSHIPS_FOR_FLOW:
        score += 10 + (arch.relationship_count * 5)
    else:
        gaps.append("No explicit relationships between components")

    type_set = {e.entity_type for e in sem.entities}
    type_diversity = len(type_set)
    if type_diversity >= 3:
        score += 20
    elif type_diversity >= 2:
        score += 12
    elif type_diversity >= 1:
        score += 5

    if arch.has_actors:
        score += 5
    else:
        gaps.append("No user/actor/client specified")

    if arch.has_data_stores:
        score += 5
    if arch.has_failure_paths:
        score += 10
    else:
        if arch.relationship_count >= 2:
            gaps.append("No failure/error handling paths described")

    return min(100, score)


def _score_specificity(sem: SemanticAnalysis, gaps: list[str]) -> int:
    score = 0

    high_conf = sum(1 for e in sem.entities if e.confidence >= 0.90)
    mid_conf = sum(1 for e in sem.entities if 0.80 <= e.confidence < 0.90)

    score += min(40, high_conf * 10)
    score += min(20, mid_conf * 5)

    if high_conf == 0 and sem.architecture.entity_count > 0:
        gaps.append("No named technologies (e.g., PostgreSQL, Kafka, Redis)")

    typed_rels = sum(
        1 for r in sem.relationships
        if r.rel_type in ("data_flow", "event", "routing", "read", "write")
    )
    score += min(25, typed_rels * 8)

    if sem.architecture.pattern != "unknown":
        score += 15
    else:
        if sem.architecture.entity_count >= 3:
            gaps.append("Architecture pattern unclear")

    return min(100, score)


def _score_structural_quality(
    sem: SemanticAnalysis,
    cls: ClassificationResult,
    gaps: list[str],
) -> int:
    score = 0
    arch = sem.architecture

    connected_entities = set()
    for r in sem.relationships:
        connected_entities.add(r.source)
        connected_entities.add(r.target)

    orphan_count = sum(
        1 for e in sem.entities
        if e.name not in connected_entities
    )
    total = max(1, arch.entity_count)
    connection_ratio = (total - orphan_count) / total

    score += int(connection_ratio * 40)
    if orphan_count > 0 and arch.entity_count >= 3:
        gaps.append(f"{orphan_count} orphan entities not connected to any flow")

    if arch.maturity == "mature":
        score += 30
    elif arch.maturity == "developing":
        score += 15
    elif arch.maturity == "nascent":
        score += 5

    if arch.has_actors and arch.has_data_stores and arch.entity_count >= 3:
        score += 15
    if sem.relationships and any(
        r.rel_type in ("data_flow", "routing") for r in sem.relationships
    ):
        score += 15
    else:
        if arch.entity_count >= 3:
            gaps.append("No clear data flow directionality")

    return min(100, score)


def _score_render_readiness(
    text: str,
    cls: ClassificationResult,
    sem: SemanticAnalysis,
    gaps: list[str],
) -> int:
    if cls.input_type == InputType.VALID_MERMAID:
        warnings = validate_basic(text)
        penalty = len(warnings) * 10
        return max(20, 100 - penalty)

    if cls.input_type == InputType.WEAK_MERMAID:
        warnings = validate_basic(text)
        if any("Unbalanced" in w for w in warnings):
            gaps.append("CRITICAL: Mermaid syntax has unbalanced brackets")
        return max(10, 60 - len(warnings) * 15)

    if cls.input_type == InputType.MIXED_ARTIFACT:
        mermaid_score = int(cls.mermaid_fraction * 60)
        prose_score = min(30, sem.architecture.quality_score * 30 // 100)
        return mermaid_score + prose_score

    if cls.input_type in (InputType.STRONG_PROSE, InputType.MARKDOWN_SPEC):
        arch = sem.architecture
        base = 20
        if arch.entity_count >= 3:
            base += 20
        if arch.relationship_count >= 2:
            base += 20
        if arch.pattern != "unknown":
            base += 15
        if arch.has_actors:
            base += 5
        if arch.has_data_stores:
            base += 5
        return min(85, base)

    if cls.input_type == InputType.DEVELOPING_PROSE:
        return min(50, 15 + sem.architecture.quality_score * 35 // 100)

    if cls.input_type == InputType.RAW_IDEA:
        return min(25, 5 + sem.architecture.entity_count * 5)

    return 10
