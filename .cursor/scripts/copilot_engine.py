"""Copilot suggestion engine for Mermaid architecture ideation.

Generates context-aware, architecture-quality completions from natural
language input.  Operates deterministically — no LLM calls.  The engine
reads the full user text, classifies intent, and produces the smallest
useful continuation that respects the user's drafting momentum.

Design principles:
  - Read first, suggest second
  - Conservative intelligence — only suggest when confidence > threshold
  - Contextual precision — complete the active thought, don't start new ones
  - Anti-repetition — never repeat the same pattern within a time window
  - Suppress over suggest — silence is preferred over generic filler
  - Good-enough detection — stop suggesting when architecture is sufficient
  - No-op rejection — never emit the same structure the user already wrote
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field

from .semantic_analyzer import (
    SemanticAnalysis,
    Entity,
    analyze as semantic_analyze,
)

# ── Configuration ────────────────────────────────────────────────────────

CONFIDENCE_THRESHOLD = 55
SUPPRESS_WINDOW_EXACT_SEC = 30.0
SUPPRESS_WINDOW_SIMILAR_SEC = 120.0
MAX_HISTORY = 20


# ── Result types ─────────────────────────────────────────────────────────

@dataclass
class CopilotSuggestion:
    suggestion: str
    confidence: int
    insertion_type: str  # "continuation" | "structural"
    reasoning: str
    suppress: bool = False


# ── Anti-repetition tracker (module-level singleton) ─────────────────────

@dataclass
class _HistoryEntry:
    suggestion_hash: str
    timestamp: float


class RepetitionTracker:
    def __init__(self) -> None:
        self._history: list[_HistoryEntry] = []

    def should_suppress(self, suggestion: str) -> bool:
        now = time.monotonic()
        h = self._hash(suggestion)
        for entry in reversed(self._history):
            age = now - entry.timestamp
            if age > SUPPRESS_WINDOW_SIMILAR_SEC:
                break
            if entry.suggestion_hash == h and age < SUPPRESS_WINDOW_EXACT_SEC:
                return True
            if entry.suggestion_hash == h:
                return True
        return False

    def record(self, suggestion: str) -> None:
        self._history.append(_HistoryEntry(
            suggestion_hash=self._hash(suggestion),
            timestamp=time.monotonic(),
        ))
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

    @staticmethod
    def _hash(text: str) -> str:
        return hashlib.md5(text.encode()).hexdigest()[:12]


_tracker = RepetitionTracker()


# ── Public API ───────────────────────────────────────────────────────────

def generate_suggestion(raw_source: str) -> CopilotSuggestion:
    """Produce a copilot suggestion for the given Simple Idea text.

    Returns a CopilotSuggestion; callers should check ``.suppress`` before
    sending to the frontend.
    """
    text = raw_source.strip()
    if not text:
        return _suppressed("Empty input")

    ctx = semantic_analyze(text)

    if ctx.architecture.quality_score < 20:
        return _suppressed("Insufficient architectural content")

    if _is_architecture_sufficient(ctx):
        return _suppressed("Architecture is already sufficient — no suggestion needed")

    suggestion, confidence, reasoning = _select_suggestion(text, ctx)

    if not suggestion or confidence < CONFIDENCE_THRESHOLD:
        return _suppressed(reasoning or "Low confidence")

    if _is_filler(suggestion):
        return _suppressed("Rejected: repetitive filler pattern")

    if _tracker.should_suppress(suggestion):
        return _suppressed("Anti-repetition: recently suggested")

    _tracker.record(suggestion)

    return CopilotSuggestion(
        suggestion=suggestion,
        confidence=confidence,
        insertion_type="continuation",
        reasoning=reasoning,
    )


def _is_architecture_sufficient(ctx) -> bool:
    """True when the architecture is complete enough that suggestions would be noise."""
    arch = ctx.architecture
    if arch.maturity != "mature":
        return False
    if arch.quality_score < 75:
        return False
    if arch.has_actors and arch.has_data_stores and arch.has_failure_paths:
        if arch.entity_count >= 5 and arch.relationship_count >= 4:
            return True
    return False


def _is_filler(suggestion: str) -> bool:
    """Reject low-quality repetitive patterns."""
    s = suggestion.strip().lower()
    filler_patterns = [
        "connects to",
        "sends to the next",
        "the system processes",
        "and then it",
        "which then",
    ]
    return any(s.endswith(p) or s == p for p in filler_patterns)


# ── Suggestion selection ─────────────────────────────────────────────────

def _select_suggestion(
    text: str,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    """Route to the right generator based on drafting state.

    Priority: complete clause > trailing verb > trailing preposition >
    trailing entity > partial thought.  A complete clause (period/semicolon)
    always wins because the user finished a thought and needs the *next* step.
    """
    d = ctx.drafting

    if d.ends_with_complete_clause:
        return _suggest_next_step(text, ctx)

    if d.ends_with_verb and d.last_verb_type:
        return _suggest_verb_target(d.active_thought, d.last_verb_type, ctx)

    if d.ends_with_preposition:
        return _suggest_preposition_target(d.active_thought, ctx)

    if d.ends_with_entity and d.last_entity:
        return _suggest_entity_action(d.active_thought, d.last_entity, ctx)

    return _suggest_thought_completion(d.active_thought, text, ctx)


# ── Generator: trailing verb needs a target ──────────────────────────────

_VERB_TARGET_BY_PATTERN: dict[str, dict[str, str]] = {
    "event_driven": {
        "read": " events from the message broker",
        "write": " events to the topic",
        "event": " the event bus for downstream consumers",
        "routing": " the appropriate event handler",
        "consume": " events from the subscribed topic",
        "failure": " to the dead letter queue after max retries",
        "process": " the incoming event payload",
        "generic_flow": " the event consumer",
    },
    "layered": {
        "read": " the persistence layer",
        "write": " the data access layer",
        "routing": " the service layer",
        "response": " the presentation layer",
        "validation": " at the boundary between layers",
        "generic_flow": " the next layer",
    },
    "pipeline": {
        "read": " the input stage",
        "write": " the output sink",
        "process": " and passes to the next stage",
        "routing": " the transformation pipeline",
        "generic_flow": " the next processing stage",
    },
}

_VERB_TARGET_DEFAULTS: dict[str, str] = {
    "read": " the data store",
    "write": " the data store",
    "event": " the message broker",
    "routing": " the backend service",
    "response": " the client",
    "validation": " the incoming request",
    "data_flow": " the downstream service",
    "consume": " the event stream",
    "deployment": " the production environment",
    "observability": " system health metrics",
    "failure": " with retry and fallback to error handling",
    "dependency": " the required infrastructure",
    "process": " the incoming payload",
    "generic_flow": " the next component",
    "security": " access credentials and tokens",
}


def _suggest_verb_target(
    active: str,
    verb_type: str,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    active_lower = active.lower()
    available = [
        e for e in ctx.entities
        if e.name.lower() not in active_lower
    ]

    preferred_types: dict[str, list[str]] = {
        "read": ["data_store"],
        "write": ["data_store"],
        "event": ["data_store", "service"],
        "routing": ["service"],
        "response": ["actor"],
        "consume": ["data_store", "service"],
    }
    type_filter = preferred_types.get(verb_type, [])

    if type_filter:
        targets = [e for e in available if e.entity_type in type_filter]
    else:
        targets = available

    if targets:
        best = max(targets, key=lambda e: e.confidence)
        return (
            f" {best.name}",
            82,
            f"Verb '{verb_type}' target → entity '{best.name}'",
        )

    pattern = ctx.architecture.pattern if ctx.architecture else "unknown"
    pattern_targets = _VERB_TARGET_BY_PATTERN.get(pattern, {})
    generic = pattern_targets.get(verb_type) or _VERB_TARGET_DEFAULTS.get(verb_type, "")
    if generic:
        return generic, 65, f"Verb '{verb_type}' → pattern-aware target ({pattern})"

    return "", 0, "No suitable target for trailing verb"


# ── Generator: trailing preposition needs an object ──────────────────────

def _suggest_preposition_target(
    active: str,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    active_lower = active.lower()
    available = [
        e for e in ctx.entities
        if e.name.lower() not in active_lower
    ]
    if available:
        best = max(available, key=lambda e: e.confidence)
        return (
            f" {best.name}",
            78,
            f"Preposition target → entity '{best.name}'",
        )
    return "", 0, "No entity available for preposition target"


# ── Generator: trailing entity needs an action ───────────────────────────

def _suggest_entity_action(
    active: str,
    last_entity: Entity,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    active_lower = active.lower()
    others = [e for e in ctx.entities if e.name.lower() not in active_lower]

    etype = last_entity.entity_type

    if etype == "service":
        stores = [e for e in others if e.entity_type == "data_store"]
        if stores:
            return (
                f" processes the request and queries {stores[0].name}",
                78,
                f"Service '{last_entity.name}' → action toward data store",
            )
        services = [e for e in others if e.entity_type == "service"]
        if services:
            return (
                f" validates the request and forwards to {services[0].name}",
                75,
                f"Service '{last_entity.name}' → action toward next service",
            )
        return " handles the incoming request and", 62, "Service with no known target"

    if etype == "data_store":
        name_lower = last_entity.name.lower()
        is_broker = any(kw in name_lower for kw in ("kafka", "rabbitmq", "nats", "pulsar", "sqs", "queue", "broker", "bus"))
        services = [e for e in others if e.entity_type == "service"]
        if is_broker and services:
            return (
                f" receives events and routes them to {services[0].name}",
                72,
                f"Broker '{last_entity.name}' → distributes to service",
            )
        if is_broker:
            return " receives events from producer services", 62, "Broker with no known consumer"
        if services:
            return (
                f" stores data for {services[0].name}",
                72,
                f"Data store '{last_entity.name}' → serves service",
            )
        return " persists and retrieves data for", 58, "Data store with no known consumer"

    if etype == "actor":
        services = [e for e in others if e.entity_type == "service"]
        if services:
            return (
                f" sends a request to {services[0].name}",
                75,
                f"Actor '{last_entity.name}' → initiates request to service",
            )
        return " initiates a request to", 60, "Actor with no known service"

    if etype == "external":
        return " provides external capabilities to the system", 58, "External system action"

    if etype == "process":
        return " executes and then triggers", 58, "Process continuation"

    if etype == "decision":
        return " evaluates the condition and routes to", 62, "Decision gate continuation"

    return "", 0, "No action for entity type"


# ── Generator: complete clause → next logical step ───────────────────────

def _suggest_next_step(
    full_text: str,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    arch = ctx.architecture
    rels = ctx.relationships
    entities = ctx.entities

    # Suggest failure path if a happy path exists but no failure handling
    if (
        arch.maturity in ("developing", "mature")
        and not arch.has_failure_paths
        and len(rels) >= 2
    ):
        actor_name = _find_entity_by_type(entities, "actor")
        if actor_name:
            return (
                f" On failure, return an error to the {actor_name}",
                72,
                "Happy path present, suggesting failure path",
            )
        return (
            " On failure, handle the error and notify the caller",
            68,
            "Happy path present, suggesting failure path (no actor found)",
        )

    # Event-driven: suggest DLQ if not present
    if arch.pattern == "event_driven":
        text_lower = full_text.lower()
        if "dead letter" not in text_lower and "dlq" not in text_lower:
            return (
                " If processing fails, route to a dead letter queue for manual review",
                70,
                "Event-driven system missing DLQ",
            )

    # Pipeline: suggest next missing stage
    if arch.pattern == "pipeline":
        return _suggest_pipeline_next(full_text, entities)

    # Suggest connecting unmentioned entity types
    if arch.has_actors and not arch.has_data_stores and arch.entity_count >= 3:
        return (
            " The service reads from the database and returns the result",
            62,
            "System has actors and services but no data store",
        )

    if arch.maturity == "developing" and arch.entity_count >= 3:
        unused = [
            e for e in entities
            if not any(
                e.name in (r.source, r.target)
                for r in rels
            )
        ]
        if unused:
            return (
                f" {unused[0].name} connects to",
                58,
                f"Orphan entity '{unused[0].name}' needs a relationship",
            )

    return "", 0, "No next step available"


def _suggest_pipeline_next(
    full_text: str,
    entities: list[Entity],
) -> tuple[str, int, str]:
    stage_keywords = ["build", "test", "lint", "scan", "deploy", "approve", "release", "monitor"]
    text_lower = full_text.lower()
    mentioned = {kw for kw in stage_keywords if kw in text_lower}
    not_mentioned = [kw for kw in stage_keywords if kw not in mentioned]
    if not_mentioned:
        return (
            f" Then run {not_mentioned[0]}",
            62,
            f"Pipeline missing '{not_mentioned[0]}' stage",
        )
    return "", 0, "Pipeline stages look complete"


# ── Generator: partial thought completion ────────────────────────────────

def _suggest_thought_completion(
    active: str,
    full_text: str,
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    active_lower = active.lower().strip()
    words = active_lower.split()

    if not words:
        return "", 0, "No words in active thought"

    # "if/when X fails" → suggest error handling
    if any(active_lower.startswith(w) for w in ("if ", "when ", "unless ")):
        if any(kw in active_lower for kw in ("fail", "error", "timeout", "reject")):
            return (
                " return an error response to the caller",
                70,
                "Conditional clause with failure keyword",
            )
        if any(kw in active_lower for kw in ("success", "valid", "approved")):
            return (
                " proceed to the next step in the pipeline",
                65,
                "Conditional clause with success keyword",
            )
        return " is unavailable, fall back to the secondary path", 60, "Open conditional"

    # "on failure" / "on error"
    if "on fail" in active_lower or "on error" in active_lower:
        actor = _find_entity_by_type(ctx.entities, "actor")
        if actor:
            return (
                f" return an error response to the {actor}",
                72,
                "Explicit failure clause",
            )
        return (
            " retry with exponential backoff or route to dead letter queue",
            68,
            "Explicit failure clause, no actor",
        )

    # "then" at end → suggest next action
    if words[-1] == "then":
        return _suggest_then_continuation(ctx)

    # Very short / non-architectural text → suppress
    if len(words) < 4 and ctx.architecture.quality_score < 30:
        return "", 0, "Too short and non-architectural"

    # Attempt a generic continuation using architecture context
    if ctx.architecture.pattern != "unknown" and ctx.architecture.entity_count >= 2:
        return _suggest_pattern_continuation(ctx)

    return "", 0, "Cannot determine useful completion"


def _suggest_then_continuation(
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    # For pipeline patterns, suggest the next missing stage first
    if ctx.architecture.pattern == "pipeline":
        result = _suggest_pipeline_next_from_context(ctx)
        if result[1] > 0:
            return result

    unused = [
        e for e in ctx.entities
        if e.entity_type != "process"  # skip bare process keywords for 'then'
        and not any(
            e.name in (r.source, r.target)
            for r in ctx.relationships
        )
    ]
    if unused:
        etype = unused[0].entity_type
        if etype == "data_store":
            return (
                f" write the result to {unused[0].name}",
                68,
                f"'then' → write to unused store '{unused[0].name}'",
            )
        if etype == "service":
            return (
                f" forward the request to {unused[0].name}",
                68,
                f"'then' → forward to unused service '{unused[0].name}'",
            )
        return (
            f" pass control to {unused[0].name}",
            62,
            f"'then' → pass to unused entity '{unused[0].name}'",
        )

    pattern_hints: dict[str, str] = {
        "event_driven": " emit an event to the message broker",
        "pipeline": " run the next stage",
        "microservices": " call the next service in the chain",
        "layered": " pass the result to the next layer",
        "state_machine": " transition to the next state",
    }
    hint = pattern_hints.get(ctx.architecture.pattern, "")
    if hint:
        return hint, 60, f"'then' → pattern hint ({ctx.architecture.pattern})"

    return "", 0, "'then' continuation unavailable"


def _suggest_pipeline_next_from_context(
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    """Suggest the next pipeline stage based on which process entities exist."""
    canonical_order = [
        "build", "lint", "test", "scan", "deploy", "approval", "release", "monitor",
    ]
    mentioned = {e.name.lower() for e in ctx.entities if e.entity_type in ("process", "decision")}
    active_lower = ctx.drafting.active_thought.lower()
    mentioned.update(kw for kw in canonical_order if kw in active_lower)

    for stage in canonical_order:
        if stage not in mentioned:
            return (
                f" {stage}",
                66,
                f"Pipeline: next missing stage is '{stage}'",
            )
    return "", 0, "All pipeline stages mentioned"


def _suggest_pattern_continuation(
    ctx: SemanticAnalysis,
) -> tuple[str, int, str]:
    pattern = ctx.architecture.pattern
    if pattern == "event_driven" and not ctx.architecture.has_failure_paths:
        return (
            ". If a consumer fails, route the message to a dead letter queue",
            65,
            "Event-driven pattern: suggesting failure path",
        )
    if pattern == "microservices" and not ctx.architecture.has_data_stores:
        return (
            ". Each service owns its own database",
            62,
            "Microservices pattern: suggesting per-service data store",
        )
    if pattern == "pipeline":
        return _suggest_pipeline_next("", ctx.entities)

    return "", 0, f"No pattern continuation for '{pattern}'"


# ── Helpers ──────────────────────────────────────────────────────────────

def _suppressed(reason: str) -> CopilotSuggestion:
    return CopilotSuggestion(
        suggestion="",
        confidence=0,
        insertion_type="continuation",
        reasoning=reason,
        suppress=True,
    )


def _find_entity_by_type(entities: list[Entity], etype: str) -> str:
    for e in entities:
        if e.entity_type == etype:
            return e.name
    return ""
