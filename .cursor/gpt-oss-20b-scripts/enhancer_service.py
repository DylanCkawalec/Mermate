"""Mermaid Enhancer Service — Standalone FastAPI app.

Run with:
    uvicorn gpt_oss.extensions.mermaid_enhancer.enhancer_service:app --port 8100

Routes by stage:
  - ``render``          → full hidden intelligence cycle (one-shot render)
  - ``copilot_suggest`` → deterministic copilot + optional LLM upgrade
  - ``copilot_enhance`` → full-text architectural enhancement
  - (default)           → deterministic OODA formatting pipeline

The visible experience is unchanged: user types, presses Render, gets result.
The hidden intelligence cycle runs silently behind the Render action.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from .copilot_engine import generate_suggestion
from .ooda_pipeline import run_pipeline
from .intelligence_core import (
    run_render_cycle,
    run_copilot_suggest,
    run_copilot_enhance,
    run_decompose_cycle,
    run_repair_from_trace,
)
from .stage_contracts import InterventionLevel

log = logging.getLogger("mermaid_enhancer")

app = FastAPI(title="Mermaid Enhancer", version="1.0.0")


# ── Request model (superset — backward compatible) ───────────────────────

class MermaidRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    raw_source: str
    stage: Optional[str] = None
    diagram_type: Optional[str] = None
    system_prompt: Optional[str] = None
    temperature: Optional[float] = None
    context: Optional[str] = None
    shadow_context: Optional[dict[str, Any]] = None
    compile_error: Optional[str] = None
    original_description: Optional[str] = None


# ── Response models ──────────────────────────────────────────────────────

class EnhanceResponse(BaseModel):
    enhanced_source: str
    transformation: str
    diagram_type: str
    complexity: str
    warnings: list[str]
    transformation_log: list[str]


class RenderResponse(BaseModel):
    """Full render cycle response."""
    mermaid_source: str
    enhanced_prose: str
    diagram_type: str
    generation_method: str
    confidence: int
    render_valid: bool
    warnings: list[str]
    trace_log: list[str]
    success: bool
    failure_reason: str
    input_type: str
    intervention: str
    provider_used: str
    model_calls: int


class CopilotSuggestResponse(BaseModel):
    suggestion: str
    confidence: str
    transformation: str
    insertion_type: str = "continuation"
    suppress: bool = False
    reasoning: str = ""


# ── Endpoints ────────────────────────────────────────────────────────────

@app.post("/mermaid/enhance")
async def enhance(req: MermaidRequest) -> dict[str, Any]:
    """Route requests by stage.

    - ``render``          → full hidden intelligence cycle
    - ``copilot_suggest`` → copilot suggestion engine
    - ``copilot_enhance`` → full-text enhancement
    - everything else     → deterministic OODA pipeline
    """
    if req.stage == "render":
        return await _handle_render(req)

    if req.stage == "decompose":
        return await _handle_decompose(req)

    if req.stage == "repair_from_trace":
        return await _handle_repair_from_trace(req)

    if req.stage == "copilot_suggest":
        return await _handle_copilot_suggest(req)

    if req.stage == "copilot_enhance":
        return await _handle_copilot_enhance(req)

    return _handle_ooda(req)


@app.get("/health")
async def health() -> dict[str, str]:
    from . import provider_layer
    has_api = provider_layer.is_available()
    has_premium = provider_layer.is_available(provider_layer.ModelTier.PREMIUM)
    return {
        "status": "ok",
        "service": "mermaid-enhancer",
        "version": "1.0.0",
        "api_available": str(has_api).lower(),
        "premium_available": str(has_premium).lower(),
    }


# ── Stage handlers ───────────────────────────────────────────────────────

async def _handle_render(req: MermaidRequest) -> dict[str, Any]:
    """Full hidden intelligence cycle — the one-shot render path."""
    result = await run_render_cycle(
        req.raw_source,
        diagram_type=req.diagram_type or "auto",
        context=req.context or "",
    )

    mermaid_source = ""
    enhanced_prose = ""
    diagram_type = "unknown"
    generation_method = "none"
    confidence = 0
    render_valid = False
    warnings: list[str] = []

    if result.mermaid:
        mermaid_source = result.mermaid.mermaid_source
        diagram_type = result.mermaid.diagram_type
        generation_method = result.mermaid.generation_method
        confidence = result.mermaid.confidence
        warnings = result.mermaid.warnings

    if result.enhancement:
        enhanced_prose = result.enhancement.enhanced_text

    if result.render_validation:
        render_valid = result.render_validation.is_renderable

    if result.repair and result.repair.success:
        mermaid_source = result.repair.repaired_source
        generation_method = "repaired"
        render_valid = True

    return RenderResponse(
        mermaid_source=mermaid_source,
        enhanced_prose=enhanced_prose,
        diagram_type=diagram_type,
        generation_method=generation_method,
        confidence=confidence,
        render_valid=render_valid,
        warnings=warnings,
        trace_log=result.trace_log,
        success=result.success,
        failure_reason=result.failure_reason.value if result.failure_reason else "",
        input_type=result.classification.input_type.value,
        intervention=result.intervention.level.value,
        provider_used=result.provider_used,
        model_calls=result.total_model_calls,
    ).model_dump()


async def _handle_copilot_suggest(req: MermaidRequest) -> dict[str, Any]:
    """Copilot suggestion — deterministic first, LLM upgrade if available."""
    det_result = generate_suggestion(req.raw_source)

    if det_result.confidence >= 70 and not det_result.suppress:
        confidence_label = "high" if det_result.confidence >= 80 else "medium"
        return CopilotSuggestResponse(
            suggestion=det_result.suggestion,
            confidence=confidence_label,
            transformation="copilot_suggest_deterministic",
            insertion_type=det_result.insertion_type,
            suppress=det_result.suppress,
            reasoning=det_result.reasoning,
        ).model_dump()

    from . import provider_layer
    if provider_layer.is_available():
        llm_result = await run_copilot_suggest(req.raw_source)
        suggestion = llm_result.get("suggestion", "")
        conf = llm_result.get("confidence", 0)

        if suggestion and conf >= 60:
            conf_label = "high" if conf >= 80 else "medium" if conf >= 60 else "low"
            return CopilotSuggestResponse(
                suggestion=suggestion,
                confidence=conf_label,
                transformation="copilot_suggest_llm",
                insertion_type="continuation",
                suppress=False,
                reasoning=llm_result.get("reasoning", ""),
            ).model_dump()

    if det_result.suggestion and not det_result.suppress:
        confidence_label = "low"
        if det_result.confidence >= 80:
            confidence_label = "high"
        elif det_result.confidence >= 60:
            confidence_label = "medium"

        return CopilotSuggestResponse(
            suggestion=det_result.suggestion,
            confidence=confidence_label,
            transformation="copilot_suggest_deterministic",
            insertion_type=det_result.insertion_type,
            suppress=det_result.suppress,
            reasoning=det_result.reasoning,
        ).model_dump()

    return CopilotSuggestResponse(
        suggestion="",
        confidence="low",
        transformation="copilot_suggest_suppressed",
        suppress=True,
        reasoning=det_result.reasoning or "Low confidence",
    ).model_dump()


async def _handle_copilot_enhance(req: MermaidRequest) -> dict[str, Any]:
    """Full-text enhancement — deterministic OODA + optional LLM upgrade."""
    from . import provider_layer

    if provider_layer.is_available():
        enhanced = await run_copilot_enhance(req.raw_source)
        if enhanced:
            return EnhanceResponse(
                enhanced_source=enhanced,
                transformation="copilot_enhance_llm",
                diagram_type="prose",
                complexity="enhanced",
                warnings=[],
                transformation_log=["LLM-assisted enhancement applied"],
            ).model_dump()

    result = run_pipeline(req.raw_source)
    return EnhanceResponse(
        enhanced_source=result.output_source,
        transformation="copilot_enhance_deterministic",
        diagram_type=result.orientation.diagram_type,
        complexity=result.orientation.complexity,
        warnings=result.observation.warnings,
        transformation_log=result.transformation_log,
    ).model_dump()


async def _handle_decompose(req: MermaidRequest) -> dict[str, Any]:
    """Decompose complex architecture into 2-4 sub-views."""
    shadow = req.shadow_context or {}
    result = await run_decompose_cycle(
        req.raw_source,
        entities=shadow.get("entities"),
        relationships=shadow.get("relationships"),
        boundaries=shadow.get("boundaries"),
        gaps=shadow.get("gaps"),
    )

    if result.success:
        return {
            "success": True,
            "sub_views": [
                {
                    "viewName": sv.view_name,
                    "viewDescription": sv.view_description,
                    "suggestedType": sv.suggested_type,
                    "entities": sv.entities,
                    "relationships": sv.relationships,
                }
                for sv in result.sub_views
            ],
            "provider_used": result.provider_used,
        }

    return {
        "success": False,
        "sub_views": [],
        "failure_reason": result.failure_reason,
    }


async def _handle_repair_from_trace(req: MermaidRequest) -> dict[str, Any]:
    """Repair failed Mermaid using structured failure trace."""
    shadow = req.shadow_context or {}
    result = await run_repair_from_trace(
        req.raw_source,
        req.compile_error or "compilation failed",
        expected_entities=shadow.get("entities"),
        expected_relationships=shadow.get("relationships"),
        gaps=shadow.get("gaps"),
        original_description=req.original_description or "",
    )

    if result.success:
        return {
            "enhanced_source": result.repaired_source,
            "transformation": "repair_from_trace",
            "provider_used": result.provider_used,
        }

    return {
        "enhanced_source": req.raw_source,
        "transformation": "repair_from_trace_failed",
        "failure_reason": result.failure_reason,
    }


def _handle_ooda(req: MermaidRequest) -> dict[str, Any]:
    """Original deterministic OODA pipeline — backward compatible."""
    result = run_pipeline(req.raw_source)
    return EnhanceResponse(
        enhanced_source=result.output_source,
        transformation=result.decision.strategy,
        diagram_type=result.orientation.diagram_type,
        complexity=result.orientation.complexity,
        warnings=result.observation.warnings,
        transformation_log=result.transformation_log,
    ).model_dump()
