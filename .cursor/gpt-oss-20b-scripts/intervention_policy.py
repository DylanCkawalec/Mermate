"""Intervention policy — decides the minimum useful action for each input.

Given classification and sufficiency scores, the policy selects exactly
the right intervention level. The core principle is: do the least
amount of work that produces a meaningful improvement. If the input
is already sufficient, stop. If it needs repair, repair. If it needs
transformation, transform. Never rewrite strong content gratuitously.
"""

from __future__ import annotations

from .stage_contracts import (
    ClassificationResult,
    InputType,
    InterventionDecision,
    InterventionLevel,
    SufficiencyScore,
    UserIntent,
)
from .provider_layer import ModelTier, is_available


def decide(
    classification: ClassificationResult,
    sufficiency: SufficiencyScore,
    *,
    render_requested: bool = False,
) -> InterventionDecision:
    """Determine the minimum useful intervention."""
    inp = classification.input_type
    intent = classification.user_intent

    if _is_already_sufficient(inp, sufficiency, render_requested):
        return InterventionDecision(
            level=InterventionLevel.STOP,
            reasoning="Input is already sufficient; no intervention needed",
            target_output_type="none",
            use_premium_model=False,
        )

    if render_requested:
        return _decide_render_path(classification, sufficiency)

    return _decide_copilot_path(classification, sufficiency)


def _is_already_sufficient(
    inp: InputType, suf: SufficiencyScore, render_requested: bool,
) -> bool:
    if render_requested:
        return (
            inp == InputType.VALID_MERMAID
            and suf.render_readiness >= 90
            and suf.overall >= 80
        )
    return suf.is_sufficient and suf.overall >= 80


def _decide_render_path(
    cls: ClassificationResult,
    suf: SufficiencyScore,
) -> InterventionDecision:
    """Full render cycle: the user pressed Render."""
    inp = cls.input_type
    use_premium = is_available(ModelTier.PREMIUM)

    if inp == InputType.VALID_MERMAID:
        if suf.render_readiness >= 80:
            return InterventionDecision(
                level=InterventionLevel.VALIDATE,
                reasoning="Valid Mermaid — validate and return",
                target_output_type="mermaid",
                use_premium_model=False,
            )
        return InterventionDecision(
            level=InterventionLevel.REPAIR,
            reasoning="Mermaid present but has issues — repair needed",
            target_output_type="mermaid",
            use_premium_model=use_premium,
            max_retries=3,
        )

    if inp == InputType.WEAK_MERMAID:
        return InterventionDecision(
            level=InterventionLevel.REPAIR,
            reasoning="Weak Mermaid syntax — repair and validate",
            target_output_type="mermaid",
            use_premium_model=use_premium,
            max_retries=3,
        )

    if inp == InputType.MIXED_ARTIFACT:
        return InterventionDecision(
            level=InterventionLevel.TRANSFORM,
            reasoning="Mixed content — extract and transform to Mermaid",
            target_output_type="both",
            use_premium_model=use_premium,
        )

    if inp in (InputType.STRONG_PROSE, InputType.MARKDOWN_SPEC):
        entity_count = len(cls.entities) if cls.entities else 0
        if suf.overall >= 50 and suf.completeness >= 40 and entity_count >= 8:
            return InterventionDecision(
                level=InterventionLevel.DECOMPOSE,
                reasoning=f"Strong prose with {entity_count} entities — decompose into sub-views before render",
                target_output_type="mermaid",
                use_premium_model=use_premium,
            )
        return InterventionDecision(
            level=InterventionLevel.RENDER,
            reasoning="Strong architecture prose — full transform to Mermaid",
            target_output_type="mermaid",
            use_premium_model=use_premium,
        )

    if inp == InputType.DEVELOPING_PROSE:
        if suf.completeness >= 40 and suf.structural_quality >= 30:
            return InterventionDecision(
                level=InterventionLevel.RENDER,
                reasoning="Developing prose with enough structure — enhance then render",
                target_output_type="both",
                use_premium_model=use_premium,
            )
        return InterventionDecision(
            level=InterventionLevel.ENHANCE,
            reasoning="Prose needs strengthening before render is viable",
            target_output_type="prose",
            use_premium_model=is_available(ModelTier.ROUTINE),
        )

    if inp == InputType.RAW_IDEA:
        if suf.completeness >= 25:
            return InterventionDecision(
                level=InterventionLevel.TRANSFORM,
                reasoning="Raw idea with some architecture signal — attempt transform",
                target_output_type="both",
                use_premium_model=use_premium,
            )
        return InterventionDecision(
            level=InterventionLevel.ENHANCE,
            reasoning="Raw idea too sparse for direct render — enhance first",
            target_output_type="prose",
            use_premium_model=is_available(ModelTier.ROUTINE),
        )

    return InterventionDecision(
        level=InterventionLevel.TRANSFORM,
        reasoning="Unclassified input — attempt full transform",
        target_output_type="both",
        use_premium_model=use_premium,
    )


def _decide_copilot_path(
    cls: ClassificationResult,
    suf: SufficiencyScore,
) -> InterventionDecision:
    """Passive/active copilot: inline suggestions and enhancements."""
    intent = cls.user_intent
    inp = cls.input_type

    if intent == UserIntent.REPAIRING:
        return InterventionDecision(
            level=InterventionLevel.REPAIR,
            reasoning="User intent signals repair needed",
            target_output_type="mermaid" if inp in (
                InputType.VALID_MERMAID, InputType.WEAK_MERMAID
            ) else "prose",
            use_premium_model=is_available(ModelTier.ROUTINE),
        )

    if intent == UserIntent.VALIDATING:
        return InterventionDecision(
            level=InterventionLevel.VALIDATE,
            reasoning="User intent signals validation requested",
            target_output_type="none",
            use_premium_model=False,
        )

    if intent == UserIntent.FINALIZING and suf.overall >= 65:
        return InterventionDecision(
            level=InterventionLevel.PREPARE_RENDER,
            reasoning="Input is mature — prepare for render",
            target_output_type="mermaid",
            use_premium_model=is_available(ModelTier.ROUTINE),
        )

    if suf.overall >= 60:
        return InterventionDecision(
            level=InterventionLevel.SUGGEST,
            reasoning="Input is developing well — light suggestions only",
            target_output_type="prose",
            use_premium_model=False,
        )

    if suf.overall >= 30:
        return InterventionDecision(
            level=InterventionLevel.ENHANCE,
            reasoning="Input has architecture signal but needs strengthening",
            target_output_type="prose",
            use_premium_model=is_available(ModelTier.ROUTINE),
        )

    if suf.overall < 15:
        return InterventionDecision(
            level=InterventionLevel.SILENT,
            reasoning="Insufficient content for useful intervention",
            target_output_type="none",
            use_premium_model=False,
        )

    return InterventionDecision(
        level=InterventionLevel.SUGGEST,
        reasoning="Default: suggest continuation",
        target_output_type="prose",
        use_premium_model=False,
    )
