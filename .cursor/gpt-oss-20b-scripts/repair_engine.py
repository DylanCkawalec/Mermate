"""Intelligent repair engine for invalid Mermaid diagrams.

Two-stage repair strategy:
  1. Deterministic repair — fixes known structural issues without LLM
  2. Model-assisted repair — uses the provider layer for complex fixes

Failed renders are treated as part of the intelligence loop, not the
end of it. The repair engine logs every action for traceability.
"""

from __future__ import annotations

import logging
import re

from .render_validator import validate
from .stage_contracts import (
    RenderStatus,
    RenderValidationResult,
    RepairResult,
)
from . import provider_layer
from .provider_layer import ModelTier

log = logging.getLogger("mermaid_enhancer.repair")


MAX_REPAIR_ATTEMPTS = 3


async def repair(
    source: str,
    validation: RenderValidationResult,
    *,
    max_attempts: int = MAX_REPAIR_ATTEMPTS,
) -> RepairResult:
    """Attempt to repair invalid Mermaid source.

    First applies deterministic fixes, then escalates to model-assisted
    repair if deterministic fixes are insufficient.
    """
    result = RepairResult(
        repaired_source=source,
        original_source=source,
        attempts=0,
    )

    current = source
    current_validation = validation

    for attempt in range(1, max_attempts + 1):
        result.attempts = attempt

        if current_validation.is_renderable:
            result.repaired_source = current
            result.success = True
            result.repair_actions.append(f"Attempt {attempt}: already valid")
            return result

        deterministic_result = _deterministic_repair(current, current_validation)
        if deterministic_result != current:
            current = deterministic_result
            result.repair_actions.append(f"Attempt {attempt}: deterministic repair applied")
            current_validation = validate(current)
            if current_validation.is_renderable:
                result.repaired_source = current
                result.success = True
                return result

        if provider_layer.is_available(ModelTier.ROUTINE):
            model_result = await _model_repair(
                current, current_validation
            )
            if model_result and model_result != current:
                current = model_result
                result.repair_actions.append(f"Attempt {attempt}: model-assisted repair applied")
                current_validation = validate(current)
                if current_validation.is_renderable:
                    result.repaired_source = current
                    result.success = True
                    return result

    result.repaired_source = current
    result.success = False
    result.repair_actions.append(
        f"Repair failed after {max_attempts} attempts: "
        + "; ".join(current_validation.errors[:3])
    )
    return result


def _deterministic_repair(
    source: str, validation: RenderValidationResult
) -> str:
    """Apply rule-based fixes for known structural issues."""
    result = source

    result = _strip_markdown_fences(result)
    result = _fix_unicode_arrows(result)
    result = _fix_bracket_balance(result)
    result = _fix_subgraph_balance(result)
    result = _ensure_directive(result)
    result = _fix_trailing_whitespace(result)

    return result


def _strip_markdown_fences(source: str) -> str:
    lines = source.splitlines()
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            continue
        cleaned.append(line)
    return "\n".join(cleaned)


def _fix_unicode_arrows(source: str) -> str:
    source = source.replace("–>", "-->")
    source = source.replace("—>", "-->")
    source = source.replace("−>", "-->")
    return source


def _fix_bracket_balance(source: str) -> str:
    for open_ch, close_ch in [("[", "]"), ("(", ")"), ("{", "}")]:
        opens = source.count(open_ch)
        closes = source.count(close_ch)
        if opens > closes:
            source += close_ch * (opens - closes)
        elif closes > opens:
            diff = closes - opens
            for _ in range(diff):
                idx = source.rfind(close_ch)
                if idx >= 0:
                    source = source[:idx] + source[idx + 1:]
    return source


def _fix_subgraph_balance(source: str) -> str:
    opens = len(re.findall(r"^\s*subgraph\b", source, re.MULTILINE))
    closes = len(re.findall(r"^\s*end\s*$", source, re.MULTILINE))
    if opens > closes:
        source += "\n" + "end\n" * (opens - closes)
    return source


def _ensure_directive(source: str) -> str:
    """If no directive is found, prepend flowchart TD."""
    lines = source.splitlines()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("%%") or stripped.startswith("classDef"):
            continue
        if re.match(
            r"^(?:flowchart|graph|sequenceDiagram|classDiagram|"
            r"stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|"
            r"timeline|journey|C4|quadrant|requirement|sankey|xychart|block)",
            stripped, re.IGNORECASE,
        ):
            return source
        break
    return "flowchart TD\n" + source


def _fix_trailing_whitespace(source: str) -> str:
    lines = [line.rstrip() for line in source.splitlines()]
    result = "\n".join(lines)
    if not result.endswith("\n"):
        result += "\n"
    return result


_REPAIR_SYSTEM_PROMPT = """\
You are a Mermaid diagram syntax repair specialist.

You receive invalid Mermaid source and a list of specific errors.
Your task is to fix ONLY the errors while preserving all existing
nodes, edges, labels, subgraphs, and structural intent.

Rules:
1. Output ONLY the repaired Mermaid source — no explanations, no markdown fences.
2. Fix the specific errors listed. Do not restructure or rewrite.
3. Preserve all node IDs, labels, and edge directions exactly.
4. Preserve subgraph structure and nesting.
5. If a node is referenced but never declared, declare it with a reasonable label.
6. If brackets are unbalanced, close them at the nearest logical point.
7. Ensure the output starts with a valid Mermaid directive.
8. Temperature: 0.0. Be deterministic and minimal.
"""


async def _model_repair(
    source: str,
    validation: RenderValidationResult,
) -> str | None:
    """Use the provider layer for model-assisted repair."""
    error_list = "\n".join(f"- {e}" for e in validation.errors)
    warning_list = "\n".join(f"- {w}" for w in validation.warnings)

    user_prompt = f"""\
Repair the following Mermaid diagram. Fix ONLY the listed errors.

ERRORS:
{error_list}

WARNINGS:
{warning_list}

SOURCE:
{source}
"""

    try:
        result = await provider_layer.complete(
            system=_REPAIR_SYSTEM_PROMPT,
            user=user_prompt,
            tier=ModelTier.ROUTINE,
            temperature=0.0,
            max_tokens=4096,
        )
        if result.success and result.text.strip():
            repaired = result.text.strip()
            repaired = _strip_markdown_fences(repaired)
            return repaired
    except Exception as exc:
        log.warning("Model repair failed: %s", exc)

    return None
