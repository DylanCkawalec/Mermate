"""Central intelligence core — mixture-of-thoughts cognition engine.

This module governs the hidden one-shot architecture cycle behind
Mermate's Render button. It is NOT a visible multi-agent workflow.
It is a single internal reasoning pipeline that inspects, classifies,
scores, decides, transforms, validates, repairs, and returns.

The visible experience: user types → presses Render → gets result.
The hidden truth: a complete architecture cognition cycle runs silently.

Design: mixture-of-thoughts, not mixture-of-agents.
  - concurrent internal reasoning passes over the input
  - convergent judgment toward a single structured result
  - disciplined OODA + architecture reasoning
  - one intelligent architect, not many noisy agents
"""

from __future__ import annotations

import logging
from dataclasses import field

from . import provider_layer
from .provider_layer import ModelTier
from .input_classifier import classify as classify_input
from .sufficiency_scorer import score as score_sufficiency
from .intervention_policy import decide as decide_intervention
from .render_validator import validate as validate_render
from .repair_engine import repair as repair_mermaid
from .noop_detector import (
    is_empty_output,
    is_noop_enhancement,
    is_trivial_mermaid,
    validate_stage_output,
)
from .ooda_pipeline import run_pipeline as run_ooda
from .prompt_templates import (
    ENHANCE_SYSTEM,
    GENERATE_MERMAID_SYSTEM,
    REFINE_MERMAID_SYSTEM,
    RENDER_CYCLE_SYSTEM,
    build_enhance_prompt,
    build_generate_mermaid_prompt,
    build_refine_mermaid_prompt,
    build_render_cycle_prompt,
)
from .stage_contracts import (
    EnhancementResult,
    InputType,
    IntelligenceCycleResult,
    InterventionLevel,
    MermaidGenerationResult,
    RenderStatus,
    RenderValidationResult,
    RepairResult,
    StageFailureReason,
)

log = logging.getLogger("mermaid_enhancer.intelligence")


async def run_render_cycle(
    text: str,
    *,
    diagram_type: str = "auto",
    context: str = "",
) -> IntelligenceCycleResult:
    """Execute the full hidden intelligence cycle.

    This is what runs when the user presses Render. It:
    1. Re-reads the full description holistically
    2. Classifies input type, intent, and architecture
    3. Scores sufficiency and render-readiness
    4. Decides the minimum useful intervention
    5. Executes the intervention (enhance, transform, repair)
    6. Validates renderability
    7. Repairs if invalid
    8. Returns only a correct final artifact or explicit failure
    """
    trace: list[str] = []
    total_calls = 0

    full_text = f"{text}\n\n{context}".strip() if context else text.strip()
    trace.append(f"Input: {len(full_text)} chars")

    # ── Phase 1: Classify ────────────────────────────────────────────
    classification = classify_input(full_text)
    trace.append(
        f"Classification: type={classification.input_type.value}, "
        f"intent={classification.user_intent.value}, "
        f"pattern={classification.architecture_pattern.value}, "
        f"maturity={classification.maturity_score}"
    )

    # ── Phase 2: Score sufficiency ───────────────────────────────────
    sufficiency = score_sufficiency(full_text, classification)
    trace.append(
        f"Sufficiency: overall={sufficiency.overall}, "
        f"render_ready={sufficiency.render_readiness}, "
        f"sufficient={sufficiency.is_sufficient}"
    )

    # ── Phase 3: Decide intervention ─────────────────────────────────
    intervention = decide_intervention(
        classification, sufficiency, render_requested=True
    )
    trace.append(
        f"Intervention: level={intervention.level.value}, "
        f"reasoning={intervention.reasoning}"
    )

    result = IntelligenceCycleResult(
        classification=classification,
        sufficiency=sufficiency,
        intervention=intervention,
        trace_log=trace,
    )

    # ── Phase 4: Execute intervention ────────────────────────────────
    if intervention.level == InterventionLevel.STOP:
        trace.append("STOP: input already sufficient")
        if classification.input_type == InputType.VALID_MERMAID:
            result.mermaid = MermaidGenerationResult(
                mermaid_source=full_text,
                diagram_type=classification.architecture_pattern.value,
                generation_method="passthrough",
                confidence=95,
            )
            result.success = True
        else:
            result.success = True
        return result

    if intervention.level == InterventionLevel.VALIDATE:
        result = await _handle_validate(full_text, result, trace)
        return result

    if intervention.level == InterventionLevel.REPAIR:
        result, total_calls = await _handle_repair_path(
            full_text, result, trace, total_calls
        )
        return result

    if intervention.level in (
        InterventionLevel.ENHANCE,
        InterventionLevel.TRANSFORM,
        InterventionLevel.RENDER,
        InterventionLevel.PREPARE_RENDER,
    ):
        result, total_calls = await _handle_render_path(
            full_text, result, trace, total_calls, diagram_type
        )
        return result

    trace.append(f"Unhandled intervention level: {intervention.level.value}")
    result.failure_reason = StageFailureReason.CONTRACT_VIOLATION
    return result


async def _handle_validate(
    text: str,
    result: IntelligenceCycleResult,
    trace: list[str],
) -> IntelligenceCycleResult:
    """Validate existing Mermaid and return."""
    validation = validate_render(text)
    result.render_validation = validation
    trace.append(f"Validation: renderable={validation.is_renderable}")

    if validation.is_renderable:
        ooda = run_ooda(text)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="passthrough",
            confidence=90,
            warnings=validation.warnings,
        )
        result.success = True
    else:
        result.mermaid = MermaidGenerationResult(
            mermaid_source=text,
            diagram_type="unknown",
            generation_method="passthrough",
            confidence=30,
            warnings=validation.errors,
        )
        repaired = await repair_mermaid(text, validation)
        result.repair = repaired
        if repaired.success:
            result.mermaid.mermaid_source = repaired.repaired_source
            result.mermaid.generation_method = "repair"
            result.mermaid.confidence = 75
            result.success = True
            trace.append("Repair succeeded after validation failure")
        else:
            result.failure_reason = StageFailureReason.INVALID_MERMAID
            trace.append("Repair failed — returning with errors")

    return result


async def _handle_repair_path(
    text: str,
    result: IntelligenceCycleResult,
    trace: list[str],
    total_calls: int,
) -> tuple[IntelligenceCycleResult, int]:
    """Repair invalid Mermaid."""
    validation = validate_render(text)
    result.render_validation = validation

    if validation.is_renderable:
        ooda = run_ooda(text)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="passthrough",
            confidence=85,
        )
        result.success = True
        return result, total_calls

    repaired = await repair_mermaid(text, validation)
    total_calls += 1
    result.repair = repaired
    trace.append(f"Repair: attempts={repaired.attempts}, success={repaired.success}")

    if repaired.success:
        ooda = run_ooda(repaired.repaired_source)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="repair",
            confidence=75,
        )
        result.success = True
    else:
        result.mermaid = MermaidGenerationResult(
            mermaid_source=repaired.repaired_source,
            diagram_type="unknown",
            generation_method="repair",
            confidence=20,
            warnings=["Repair failed: " + "; ".join(repaired.repair_actions[-1:])],
        )
        result.failure_reason = StageFailureReason.INVALID_MERMAID

    result.total_model_calls = total_calls
    return result, total_calls


async def _handle_render_path(
    text: str,
    result: IntelligenceCycleResult,
    trace: list[str],
    total_calls: int,
    diagram_type: str,
) -> tuple[IntelligenceCycleResult, int]:
    """Full render path: enhance → generate Mermaid → validate → repair."""
    cls = result.classification
    suf = result.sufficiency
    intervention = result.intervention
    use_premium = intervention.use_premium_model

    working_text = text
    enhancement = None

    # ── Step 1: Enhance if needed (quality gate) ────────────────────
    should_enhance = (
        intervention.level in (InterventionLevel.ENHANCE, InterventionLevel.RENDER)
        and (suf.completeness < 60 or not suf.is_render_ready)
    )
    if should_enhance and provider_layer.is_available(ModelTier.ROUTINE):
        trace.append("Enhancing prose before render (render_ready=%s)" % suf.is_render_ready)
        enhanced = await _enhance_text(
            working_text, cls, suf, use_premium=False
        )
        total_calls += 1

        if enhanced and not is_noop_enhancement(working_text, enhanced):
            enhancement = EnhancementResult(
                enhanced_text=enhanced,
                original_text=working_text,
                changes_made=["Architecture enhancement applied"],
                intervention_level=InterventionLevel.ENHANCE,
            )
            working_text = enhanced
            result.enhancement = enhancement
            trace.append("Enhancement produced meaningful changes")
        else:
            trace.append("Enhancement was no-op — proceeding with original")

    # ── Step 2: Generate Mermaid ─────────────────────────────────────
    tier = ModelTier.PREMIUM if use_premium else ModelTier.ROUTINE

    if not provider_layer.is_available(tier):
        if provider_layer.is_available(ModelTier.ROUTINE):
            tier = ModelTier.ROUTINE
        else:
            trace.append("No model available — falling back to deterministic OODA")
            return _fallback_deterministic(text, result, trace, total_calls)

    mermaid_source = await _generate_mermaid(
        working_text, cls, suf, diagram_type, tier
    )
    total_calls += 1
    result.provider_used = tier.value
    trace.append(f"Mermaid generated via {tier.value} model")

    # ── Step 3: Validate output ──────────────────────────────────────
    valid, reason = validate_stage_output("transform", text, mermaid_source)
    if not valid:
        trace.append(f"Output validation failed: {reason}")
        if tier == ModelTier.ROUTINE and provider_layer.is_available(ModelTier.PREMIUM):
            trace.append("Retrying with premium model")
            mermaid_source = await _generate_mermaid(
                working_text, cls, suf, diagram_type, ModelTier.PREMIUM
            )
            total_calls += 1
            result.provider_used = "premium"
            valid, reason = validate_stage_output("transform", text, mermaid_source)

    if not valid or is_trivial_mermaid(mermaid_source):
        trace.append("Generated Mermaid failed validation — attempting deterministic fallback")
        return _fallback_deterministic(text, result, trace, total_calls)

    # ── Step 4: Render validation ────────────────────────────────────
    render_val = validate_render(mermaid_source)
    result.render_validation = render_val
    trace.append(f"Render validation: renderable={render_val.is_renderable}")

    if render_val.is_renderable:
        ooda = run_ooda(mermaid_source)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="generate",
            confidence=85,
            warnings=render_val.warnings,
        )
        result.success = True
        result.total_model_calls = total_calls
        return result, total_calls

    # ── Step 5: Repair loop ──────────────────────────────────────────
    trace.append("Generated Mermaid not renderable — entering repair loop")
    repaired = await repair_mermaid(
        mermaid_source, render_val, max_attempts=intervention.max_retries
    )
    total_calls += 1
    result.repair = repaired
    trace.append(f"Repair: attempts={repaired.attempts}, success={repaired.success}")

    if repaired.success:
        ooda = run_ooda(repaired.repaired_source)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="generate+repair",
            confidence=70,
            warnings=repaired.repair_actions,
        )
        result.success = True
    else:
        trace.append("Base repair failed — trying architecture-aware repair-from-trace")
        trace_repair = await run_repair_from_trace(
            repaired.repaired_source or mermaid_source,
            "; ".join(render_val.errors[:3]) if render_val.errors else "render validation failed",
            expected_entities=cls.entities,
            expected_relationships=cls.relationships,
            original_description=text[:2000],
        )
        total_calls += 1

        if trace_repair.success:
            trace_val = validate_render(trace_repair.repaired_source)
            if trace_val.is_renderable:
                ooda = run_ooda(trace_repair.repaired_source)
                result.mermaid = MermaidGenerationResult(
                    mermaid_source=ooda.output_source,
                    diagram_type=ooda.orientation.diagram_type,
                    generation_method="generate+repair_from_trace",
                    confidence=60,
                    warnings=["Repaired via structured failure trace"],
                )
                result.success = True
                trace.append("Repair-from-trace succeeded")
            else:
                trace.append("Repair-from-trace output not renderable")

        if not result.success:
            result.mermaid = MermaidGenerationResult(
                mermaid_source=repaired.repaired_source,
                diagram_type="unknown",
                generation_method="generate+repair",
                confidence=25,
                warnings=["Render validation failed after all repair attempts"],
            )
            result.failure_reason = StageFailureReason.INVALID_MERMAID
            trace.append("All repair paths exhausted — returning best effort")

    result.total_model_calls = total_calls
    return result, total_calls


def _fallback_deterministic(
    text: str,
    result: IntelligenceCycleResult,
    trace: list[str],
    total_calls: int,
) -> tuple[IntelligenceCycleResult, int]:
    """Fall back to the deterministic OODA pipeline when models fail."""
    cls = result.classification

    if cls.input_type in (InputType.VALID_MERMAID, InputType.WEAK_MERMAID, InputType.MIXED_ARTIFACT):
        ooda = run_ooda(text)
        result.mermaid = MermaidGenerationResult(
            mermaid_source=ooda.output_source,
            diagram_type=ooda.orientation.diagram_type,
            generation_method="deterministic_ooda",
            confidence=50,
            warnings=ooda.observation.warnings,
        )
        result.success = True
        trace.append("Deterministic OODA fallback applied to Mermaid-like input")
    else:
        result.mermaid = MermaidGenerationResult(
            mermaid_source="",
            diagram_type="unknown",
            generation_method="fallback_failed",
            confidence=0,
            warnings=["No model available and input is not Mermaid"],
        )
        result.failure_reason = StageFailureReason.MODEL_UNAVAILABLE
        trace.append("No model and non-Mermaid input — cannot generate diagram")

    result.total_model_calls = total_calls
    return result, total_calls


async def _enhance_text(
    text: str,
    cls,
    suf,
    *,
    use_premium: bool = False,
) -> str | None:
    """Enhance prose using the provider layer."""
    tier = ModelTier.PREMIUM if use_premium else ModelTier.ROUTINE
    prompt = build_enhance_prompt(
        text,
        problem_statement=cls.problem_statement,
        entities=cls.entities,
        architecture_pattern=cls.architecture_pattern.value,
        gaps=suf.gaps,
    )

    try:
        result = await provider_layer.complete(
            system=ENHANCE_SYSTEM,
            user=prompt,
            tier=tier,
            temperature=0.0,
            max_tokens=4096,
        )
        if result.success and result.text.strip():
            enhanced = result.text.strip()
            if "[SUFFICIENT" in enhanced:
                return None
            return enhanced
    except Exception as exc:
        log.warning("Enhancement failed: %s", exc)

    return None


async def _generate_mermaid(
    text: str,
    cls,
    suf,
    diagram_type: str,
    tier: ModelTier,
) -> str:
    """Generate Mermaid from text using the provider layer."""
    is_render_cycle = suf.render_readiness >= 30

    if is_render_cycle:
        system = RENDER_CYCLE_SYSTEM
        prompt = build_render_cycle_prompt(
            text,
            problem_statement=cls.problem_statement,
            entities=cls.entities,
            relationships=cls.relationships,
            architecture_pattern=cls.architecture_pattern.value,
            diagram_type=diagram_type,
            sufficiency_score=suf.overall,
            gaps=suf.gaps,
        )
    else:
        system = GENERATE_MERMAID_SYSTEM
        prompt = build_generate_mermaid_prompt(
            text,
            diagram_type=diagram_type,
            entities=cls.entities,
            relationships=cls.relationships,
            architecture_pattern=cls.architecture_pattern.value,
        )

    try:
        result = await provider_layer.complete(
            system=system,
            user=prompt,
            tier=tier,
            temperature=0.0,
            max_tokens=8192,
        )
        if result.success and result.text.strip():
            return _clean_mermaid_output(result.text)
    except Exception as exc:
        log.warning("Mermaid generation failed: %s", exc)

    return ""


def _clean_mermaid_output(text: str) -> str:
    """Strip markdown fences and leading/trailing noise from model output."""
    lines = text.strip().splitlines()
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            continue
        cleaned.append(line)
    result = "\n".join(cleaned).strip()
    if not result.endswith("\n"):
        result += "\n"
    return result


# ── Copilot integration ──────────────────────────────────────────────────

async def run_copilot_suggest(text: str) -> dict:
    """Run intelligence-aware copilot suggestion.

    Returns the suggestion dict for the enhancer service.
    Used when an LLM is available for higher-quality suggestions
    than the deterministic copilot engine.
    """
    from .prompt_templates import (
        COPILOT_SUGGEST_SYSTEM,
        build_copilot_suggest_prompt,
    )
    from .semantic_analyzer import analyze as sem_analyze

    if not provider_layer.is_available(ModelTier.ROUTINE):
        return {"suggestion": "", "confidence": 0, "reasoning": "No model available"}

    sem = sem_analyze(text)
    active_thought = sem.drafting.active_thought

    prompt = build_copilot_suggest_prompt(
        text,
        active_thought,
        entities=[e.name for e in sem.entities],
        relationships=[f"{r.source} {r.verb} {r.target}" for r in sem.relationships],
        architecture_pattern=sem.architecture.pattern,
        quality_score=sem.architecture.quality_score,
    )

    try:
        result = await provider_layer.complete(
            system=COPILOT_SUGGEST_SYSTEM,
            user=prompt,
            tier=ModelTier.ROUTINE,
            temperature=0.0,
            max_tokens=512,
            response_format="json_object",
        )
        if result.success:
            data = result.parse_json()
            return {
                "suggestion": data.get("suggestion", ""),
                "confidence": data.get("confidence", 0),
                "reasoning": data.get("reasoning", ""),
            }
    except Exception as exc:
        log.warning("Copilot suggest failed: %s", exc)

    return {"suggestion": "", "confidence": 0, "reasoning": "Model call failed"}


async def run_decompose_cycle(
    text: str,
    *,
    entities: list[str] | None = None,
    relationships: list[str] | None = None,
    boundaries: list[str] | None = None,
    gaps: list[str] | None = None,
) -> "DecomposeResult":
    """Decompose a complex architecture into 2-4 renderable sub-views.

    Uses bounded candidate generation: up to 2 attempts, with validation
    after each attempt to ensure sub-views are coherent and non-trivial.
    """
    from .prompt_templates import DECOMPOSE_SYSTEM, build_decompose_prompt
    from .stage_contracts import DecomposeResult, SubViewPlan
    import json

    entity_count = len(entities) if entities else 0
    max_attempts = 2

    for attempt in range(1, max_attempts + 1):
        if attempt == 1:
            prompt = build_decompose_prompt(
                text, entities=entities, relationships=relationships,
                boundaries=boundaries, gaps=gaps,
            )
        else:
            prompt = build_decompose_prompt(
                text, entities=entities, relationships=relationships,
                boundaries=boundaries, gaps=gaps,
            )
            prompt += (
                f"\n\nIMPORTANT: Previous attempt failed validation."
                f" The input has {entity_count} entities across multiple domains."
                f" You MUST produce at least 2 sub-views. Each viewDescription MUST"
                f" mention at least 2 entities by name and contain at least 3 sentences."
            )

        try:
            result = await provider_layer.complete(
                system=DECOMPOSE_SYSTEM,
                user=prompt,
                tier=ModelTier.PREMIUM,
                temperature=0.0,
                max_tokens=4096,
                response_format="json_object",
            )
            if not (result.success and result.text):
                log.warning("Decompose attempt %d: empty output", attempt)
                continue

            raw = result.text.strip()
            json_start = raw.find("[")
            json_end = raw.rfind("]")
            if json_start < 0 or json_end <= json_start:
                log.warning("Decompose attempt %d: no JSON array found", attempt)
                continue

            arr = json.loads(raw[json_start : json_end + 1])
            sub_views = []
            for item in arr[:4]:
                desc = item.get("viewDescription", "")
                name = item.get("viewName", "unnamed")
                view_entities = item.get("entities", [])

                if len(desc.split('.')) < 2 or len(view_entities) < 2:
                    log.info("Decompose: skipping shallow sub-view '%s'", name)
                    continue

                sub_views.append(SubViewPlan(
                    view_name=name,
                    view_description=desc,
                    suggested_type=item.get("suggestedType", "flowchart TB"),
                    entities=view_entities,
                    relationships=item.get("relationships", []),
                ))

            if len(sub_views) >= 2:
                log.info("Decompose attempt %d: %d valid sub-views", attempt, len(sub_views))
                return DecomposeResult(
                    sub_views=sub_views,
                    provider_used=result.provider or "unknown",
                    success=True,
                )

            log.warning("Decompose attempt %d: only %d valid sub-views", attempt, len(sub_views))

        except Exception as exc:
            log.warning("Decompose attempt %d failed: %s", attempt, exc)

    return DecomposeResult(success=False, failure_reason="all decompose attempts failed validation")


async def run_repair_from_trace(
    failed_source: str,
    compile_error: str,
    *,
    expected_entities: list[str] | None = None,
    expected_relationships: list[str] | None = None,
    gaps: list[str] | None = None,
    original_description: str = "",
) -> "RepairFromTraceResult":
    """Repair failed Mermaid using structured failure trace and shadow model."""
    from .prompt_templates import REPAIR_FROM_TRACE_SYSTEM, build_repair_from_trace_prompt
    from .stage_contracts import RepairFromTraceResult

    prompt = build_repair_from_trace_prompt(
        failed_source,
        compile_error,
        expected_entities=expected_entities,
        expected_relationships=expected_relationships,
        gaps=gaps,
        original_description=original_description,
    )

    try:
        result = await provider_layer.complete(
            system=REPAIR_FROM_TRACE_SYSTEM,
            user=prompt,
            tier=ModelTier.PREMIUM,
            temperature=0.0,
            max_tokens=4096,
        )
        if result.success and result.text:
            import re
            first_line = next((l for l in result.text.split("\n") if l.strip() and not l.strip().startswith("%%")), "")
            directive_re = re.compile(r"^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey)\b", re.IGNORECASE)
            if directive_re.match(first_line.strip()):
                return RepairFromTraceResult(repaired_source=result.text.strip(), provider_used=result.provider or "unknown", success=True)

        log.warning("Repair from trace returned unusable output")
        return RepairFromTraceResult(success=False, failure_reason="unusable model output")

    except Exception as exc:
        log.warning("Repair from trace failed: %s", exc)
        return RepairFromTraceResult(success=False, failure_reason=str(exc))


async def run_copilot_enhance(text: str) -> str | None:
    """Run intelligence-aware full-text enhancement.

    Returns the enhanced text or None if enhancement was not useful.
    """
    cls = classify_input(text)
    suf = score_sufficiency(text, cls)

    if suf.is_sufficient and suf.overall >= 80:
        return None

    enhanced = await _enhance_text(text, cls, suf)
    if enhanced and not is_noop_enhancement(text, enhanced):
        return enhanced

    return None
