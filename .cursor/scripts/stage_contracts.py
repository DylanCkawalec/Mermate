"""Stage output contracts for the gpt-oss intelligence pipeline.

Every stage in the hidden render cycle produces a typed result object.
Downstream stages and the final response builder validate these contracts
to prevent false-success propagation (empty outputs, unchanged prose,
non-Mermaid data in Mermaid-required stages, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class InputType(Enum):
    RAW_IDEA = "raw_idea"
    DEVELOPING_PROSE = "developing_prose"
    STRONG_PROSE = "strong_prose"
    MARKDOWN_SPEC = "markdown_spec"
    MALFORMED_MARKDOWN = "malformed_markdown"
    VALID_MERMAID = "valid_mermaid"
    WEAK_MERMAID = "weak_mermaid"
    MIXED_ARTIFACT = "mixed_artifact"
    REFERENCE_CONTEXT = "reference_context"


class UserIntent(Enum):
    BRAINSTORMING = "brainstorming"
    STRUCTURING = "structuring"
    REFINING = "refining"
    VALIDATING = "validating"
    REPAIRING = "repairing"
    FINALIZING = "finalizing"


class InterventionLevel(Enum):
    SILENT = "silent"
    SUGGEST = "suggest"
    ENHANCE = "enhance"
    REPAIR = "repair"
    VALIDATE = "validate"
    TRANSFORM = "transform"
    DECOMPOSE = "decompose"
    PREPARE_RENDER = "prepare_render"
    RENDER = "render"
    STOP = "stop"


class ArchitecturePattern(Enum):
    MICROSERVICES = "microservices"
    EVENT_DRIVEN = "event_driven"
    LAYERED = "layered"
    PIPELINE = "pipeline"
    STATE_MACHINE = "state_machine"
    CLIENT_SERVER = "client_server"
    HEXAGONAL = "hexagonal"
    CQRS = "cqrs"
    UNKNOWN = "unknown"


class RenderStatus(Enum):
    VALID = "valid"
    INVALID_SYNTAX = "invalid_syntax"
    INVALID_STRUCTURE = "invalid_structure"
    REPAIRED = "repaired"
    REPAIR_FAILED = "repair_failed"
    NOT_ATTEMPTED = "not_attempted"


class StageFailureReason(Enum):
    NOOP = "noop"
    EMPTY_OUTPUT = "empty_output"
    CONTRACT_VIOLATION = "contract_violation"
    UNCHANGED_FROM_INPUT = "unchanged_from_input"
    INVALID_MERMAID = "invalid_mermaid"
    MODEL_REFUSAL = "model_refusal"
    MODEL_UNAVAILABLE = "model_unavailable"
    TIMEOUT = "timeout"
    MAX_RETRIES = "max_retries"


# ── Classification result ────────────────────────────────────────────────

@dataclass(frozen=True)
class ClassificationResult:
    input_type: InputType
    user_intent: UserIntent
    architecture_pattern: ArchitecturePattern
    maturity_score: int           # 0-100: how developed the input is
    mermaid_fraction: float       # 0.0-1.0: portion that is valid Mermaid
    problem_statement: str        # inferred one-line problem description
    entities: list[str] = field(default_factory=list)
    relationships: list[str] = field(default_factory=list)


# ── Sufficiency result ───────────────────────────────────────────────────

@dataclass(frozen=True)
class SufficiencyScore:
    completeness: int             # 0-100
    specificity: int              # 0-100
    structural_quality: int       # 0-100
    render_readiness: int         # 0-100
    overall: int                  # 0-100 weighted composite
    is_sufficient: bool           # True if no intervention needed
    is_render_ready: bool = False # True if quality is high enough to render without further enhancement
    gaps: list[str] = field(default_factory=list)


# ── Intervention decision ────────────────────────────────────────────────

@dataclass(frozen=True)
class InterventionDecision:
    level: InterventionLevel
    reasoning: str
    target_output_type: str       # "prose" | "mermaid" | "both" | "none"
    use_premium_model: bool
    max_retries: int = 2


# ── Stage results ────────────────────────────────────────────────────────

@dataclass
class EnhancementResult:
    enhanced_text: str
    original_text: str
    changes_made: list[str] = field(default_factory=list)
    entities_preserved: bool = True
    intervention_level: InterventionLevel = InterventionLevel.ENHANCE

    @property
    def is_noop(self) -> bool:
        return self.enhanced_text.strip() == self.original_text.strip()


@dataclass
class MermaidGenerationResult:
    mermaid_source: str
    diagram_type: str
    generation_method: str        # "transform" | "generate" | "repair" | "passthrough"
    confidence: int               # 0-100
    warnings: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.mermaid_source.strip()


@dataclass
class RenderValidationResult:
    status: RenderStatus
    is_renderable: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error_lines: list[int] = field(default_factory=list)


@dataclass
class RepairResult:
    repaired_source: str
    original_source: str
    repair_actions: list[str] = field(default_factory=list)
    attempts: int = 0
    success: bool = False

    @property
    def is_noop(self) -> bool:
        return self.repaired_source.strip() == self.original_source.strip()


# ── Full pipeline result ─────────────────────────────────────────────────

@dataclass
class IntelligenceCycleResult:
    """Final output of one complete hidden intelligence cycle."""

    classification: ClassificationResult
    sufficiency: SufficiencyScore
    intervention: InterventionDecision
    enhancement: EnhancementResult | None = None
    mermaid: MermaidGenerationResult | None = None
    render_validation: RenderValidationResult | None = None
    repair: RepairResult | None = None

    trace_log: list[str] = field(default_factory=list)
    provider_used: str = "none"
    total_model_calls: int = 0
    success: bool = False
    failure_reason: StageFailureReason | None = None

    @property
    def final_output(self) -> str:
        """The best available output after the full cycle."""
        if self.repair and self.repair.success:
            return self.repair.repaired_source
        if self.mermaid and not self.mermaid.is_empty:
            return self.mermaid.mermaid_source
        if self.enhancement and not self.enhancement.is_noop:
            return self.enhancement.enhanced_text
        if self.classification:
            return ""
        return ""

    @property
    def final_diagram_type(self) -> str:
        if self.mermaid:
            return self.mermaid.diagram_type
        return "unknown"


# ── Decomposition results ────────────────────────────────────────────────

@dataclass
class SubViewPlan:
    view_name: str
    view_description: str
    suggested_type: str = "flowchart TB"
    entities: list[str] = field(default_factory=list)
    relationships: list[str] = field(default_factory=list)


@dataclass
class DecomposeResult:
    sub_views: list[SubViewPlan] = field(default_factory=list)
    provider_used: str = "none"
    success: bool = False
    failure_reason: str = ""


@dataclass
class RepairFromTraceResult:
    repaired_source: str = ""
    provider_used: str = "none"
    success: bool = False
    failure_reason: str = ""


@dataclass
class SubViewScore:
    compilability: float = 0.0
    entity_coverage: float = 0.0
    edge_density: float = 0.0
    composite: float = 0.0
