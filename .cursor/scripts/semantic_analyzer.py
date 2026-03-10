"""Semantic analysis of natural language for architecture copilot suggestions.

Extracts entities, relationships, drafting intent, and architecture profile
from plain-English system descriptions. Used by the copilot engine to generate
context-aware suggestions instead of generic fillers.

Derived from the axiom framework in mermaid-axioms.md (AX-I-2, AX-I-3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


# ── Named technology → entity type (highest confidence) ──────────────────

_NAMED_TECHNOLOGIES: dict[str, str] = {
    "postgresql": "data_store", "postgres": "data_store", "mysql": "data_store",
    "mariadb": "data_store", "mongodb": "data_store", "mongo": "data_store",
    "cassandra": "data_store", "cockroachdb": "data_store", "neo4j": "data_store",
    "dynamodb": "data_store", "cosmosdb": "data_store", "firestore": "data_store",
    "supabase": "data_store", "sqlite": "data_store",
    "redis": "data_store", "memcached": "data_store", "valkey": "data_store",
    "elasticsearch": "data_store", "opensearch": "data_store", "solr": "data_store",
    "pinecone": "data_store", "weaviate": "data_store", "qdrant": "data_store",
    "milvus": "data_store", "chromadb": "data_store",
    "kafka": "data_store", "rabbitmq": "data_store", "nats": "data_store",
    "pulsar": "data_store", "activemq": "data_store",
    "snowflake": "data_store", "bigquery": "data_store", "redshift": "data_store",
    "clickhouse": "data_store", "databricks": "data_store",
    "s3": "data_store", "gcs": "data_store", "minio": "data_store",
    "stripe": "external", "twilio": "external", "sendgrid": "external",
    "auth0": "external", "okta": "external", "datadog": "external",
    "pagerduty": "external", "sentry": "external", "grafana": "external",
    "prometheus": "external", "jaeger": "external",
    "kubernetes": "service", "docker": "service",
    "istio": "service", "envoy": "service", "nginx": "service",
    "haproxy": "service", "traefik": "service", "consul": "service",
    "terraform": "process", "argocd": "process", "jenkins": "process",
}

# ── Multi-word entity phrases (matched before single-word patterns) ──────

_MULTI_WORD_ENTITIES: list[tuple[str, str]] = [
    ("dead letter queue", "data_store"),
    ("message queue", "data_store"),
    ("event store", "data_store"),
    ("event bus", "service"),
    ("message broker", "service"),
    ("api gateway", "service"),
    ("load balancer", "service"),
    ("reverse proxy", "service"),
    ("service mesh", "service"),
    ("circuit breaker", "service"),
    ("rate limiter", "service"),
    ("data warehouse", "data_store"),
    ("data lake", "data_store"),
    ("object store", "data_store"),
    ("key-value store", "data_store"),
    ("search index", "data_store"),
    ("session store", "data_store"),
    ("artifact registry", "data_store"),
    ("container registry", "data_store"),
    ("secret vault", "data_store"),
    ("secrets manager", "data_store"),
    ("ci/cd pipeline", "process"),
    ("build pipeline", "process"),
    ("data pipeline", "process"),
    ("etl pipeline", "process"),
    ("canary deploy", "process"),
    ("blue-green deploy", "process"),
    ("manual approval", "decision"),
    ("approval gate", "decision"),
    ("security scan", "process"),
    ("code review", "process"),
    ("health check", "process"),
]

# ── "<qualifier> <suffix>" compounds (e.g. "user service") ──────────────

_ENTITY_SUFFIXES: dict[str, str] = {
    "service": "service", "server": "service", "worker": "service",
    "handler": "service", "controller": "service", "engine": "service",
    "gateway": "service", "proxy": "service", "router": "service",
    "balancer": "service", "broker": "service", "registry": "service",
    "orchestrator": "service", "scheduler": "service", "dispatcher": "service",
    "middleware": "service", "microservice": "service", "adapter": "service",
    "connector": "service", "bridge": "service",
    "database": "data_store", "db": "data_store", "cache": "data_store",
    "store": "data_store", "queue": "data_store", "bucket": "data_store",
    "index": "data_store", "topic": "data_store", "stream": "data_store",
    "vault": "data_store", "ledger": "data_store",
    "pipeline": "process", "workflow": "process",
    "provider": "external", "vendor": "external",
}

# ── Standalone entity keywords (lower confidence) ───────────────────────

_BARE_ENTITY_KEYWORDS: dict[str, str] = {
    "user": "actor", "client": "actor", "browser": "actor",
    "admin": "actor", "operator": "actor", "customer": "actor",
    "developer": "actor", "visitor": "actor",
    "frontend": "service", "backend": "service", "api": "service",
    "firewall": "service", "waf": "service", "cdn": "external",
    "dns": "external",
    "build": "process", "deploy": "process", "test": "process",
    "lint": "process", "scan": "process", "release": "process",
    "monitor": "process", "approval": "decision",
}

# ── Relationship verb patterns (AX-I-3) ─────────────────────────────────

_RELATIONSHIP_VERBS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\b(?:sends?|calls?|requests?|invokes?|hits?)\s+(?:to\s+)?", re.I), "data_flow", "sends to"),
    (re.compile(r"\b(?:reads?|quer(?:y|ies)|fetch(?:es)?|gets?|loads?|retriev(?:es?|ing))\s+(?:from\s+)?", re.I), "read", "reads from"),
    (re.compile(r"\b(?:writes?|stor(?:es?|ing)|sav(?:es?|ing)|inserts?|persists?|puts?)\s+(?:(?:in|to|into)\s+)?", re.I), "write", "writes to"),
    (re.compile(r"\b(?:triggers?|emits?|fires?|publish(?:es)?|broadcasts?|produc(?:es?|ing))\s+(?:(?:to|event)\s+)?", re.I), "event", "emits to"),
    (re.compile(r"\b(?:depends?\s+on|requires?|needs?|relies?\s+on)\b", re.I), "dependency", "depends on"),
    (re.compile(r"\b(?:validates?|authenticates?|authorizes?|checks?|verif(?:y|ies)|inspects?)\b", re.I), "validation", "validates"),
    (re.compile(r"\b(?:routes?\s+(?:to)?|forwards?\s+(?:to)?|redirects?\s+(?:to)?|proxies?\s+(?:to)?|distributes?\s+(?:to)?)\b", re.I), "routing", "routes to"),
    (re.compile(r"\b(?:returns?\s+(?:to)?|responds?\s+(?:to|with)?|replies?\s+(?:to|with)?)\b", re.I), "response", "returns"),
    (re.compile(r"\b(?:consumes?\s+(?:from)?|subscribes?\s+(?:to)?|listens?\s+(?:to|on|for)?|receives?\s+(?:from)?)\b", re.I), "consume", "consumes"),
    (re.compile(r"\b(?:processes?|handles?|executes?|runs?|performs?)\b", re.I), "process", "processes"),
    (re.compile(r"\b(?:connects?\s+(?:to)?|communicates?\s+(?:with)?|talks?\s+(?:to)?)\b", re.I), "generic_flow", "connects to"),
    (re.compile(r"\b(?:deploys?\s+(?:to)?|pushes?\s+(?:to)?|ships?\s+(?:to)?)\b", re.I), "deployment", "deploys to"),
    (re.compile(r"\b(?:monitors?|observes?|tracks?|logs?|traces?|audits?)\b", re.I), "observability", "monitors"),
    (re.compile(r"\b(?:retries?|falls?\s*back|failovers?)\b", re.I), "failure", "retries"),
]

# Detect a trailing verb/preposition at the end of the user's text
_TRAILING_VERB_RE = re.compile(
    r"\b(?:sends?|calls?|routes?|forwards?|reads?|writes?|queries?|"
    r"stores?|validates?|connects?|triggers?|emits?|publishes?|"
    r"consumes?|processes?|handles?|authenticates?|returns?|responds?|"
    r"deploys?|pushes?|monitors?|logs?|checks?|verif(?:y|ies)|"
    r"loads?|fetches?|gets?|saves?|invokes?|hits?|requests?|"
    r"subscribes?|listens?|receives?|distributes?|proxies?|"
    r"broadcasts?|produces?|fires?|inspects?|redirects?)"
    r"(?:\s+(?:to|from|in|into|at|on|with|for))?\s*$",
    re.IGNORECASE,
)

_TRAILING_PREP_RE = re.compile(
    r"\b(?:to|from|into|onto|with|for|on|at|via|through|by)\s*$",
    re.IGNORECASE,
)

# ── Architecture pattern signals ─────────────────────────────────────────

_ARCHITECTURE_SIGNALS: dict[str, list[str]] = {
    "microservices": [
        "microservice", "api gateway", "service mesh", "service discovery",
        "sidecar", "inter-service",
    ],
    "event_driven": [
        "event", "emit", "publish", "subscribe", "consumer", "producer",
        "broker", "kafka", "rabbitmq", "event bus", "dead letter", "saga",
    ],
    "layered": [
        "frontend", "backend", "database", "presentation", "business logic",
        "data layer", "three-tier", "3-tier",
    ],
    "pipeline": [
        "pipeline", "stage", "step", "build", "test", "deploy",
        "ci/cd", "ci cd", "etl", "transform", "ingest",
    ],
    "state_machine": [
        "state", "transition", "lifecycle", "pending", "active",
        "failed", "succeeded", "running", "idle",
    ],
}

_FAILURE_KEYWORDS = frozenset({
    "fail", "failure", "error", "timeout", "retry", "fallback",
    "dead letter", "reject", "deny", "unauthorized", "exception",
    "rollback", "circuit breaker", "404", "401", "403", "500",
})

_ARCH_BONUS_KEYWORDS = frozenset({
    "architecture", "system", "design", "flow", "pipeline", "layer",
    "component", "module", "interface", "protocol", "endpoint",
    "request", "response", "infrastructure",
})


# ── Data classes ─────────────────────────────────────────────────────────

@dataclass
class Entity:
    name: str
    entity_type: str
    confidence: float
    start: int
    end: int


@dataclass
class Relationship:
    source: str
    target: str
    verb: str
    rel_type: str


@dataclass
class DraftingIntent:
    intent: str
    active_thought: str
    thought_completeness: float
    ends_with_entity: bool
    ends_with_verb: bool
    ends_with_preposition: bool
    ends_with_complete_clause: bool
    last_entity: Entity | None
    last_verb_type: str | None


@dataclass
class ArchitectureProfile:
    pattern: str
    maturity: str
    has_failure_paths: bool
    has_data_stores: bool
    has_external_systems: bool
    has_actors: bool
    entity_count: int
    relationship_count: int
    quality_score: int


@dataclass
class SemanticAnalysis:
    entities: list[Entity]
    relationships: list[Relationship]
    drafting: DraftingIntent
    architecture: ArchitectureProfile


# ── Public entry point ───────────────────────────────────────────────────

def analyze(text: str) -> SemanticAnalysis:
    """Full semantic analysis of natural language text."""
    entities = _extract_entities(text)
    relationships = _extract_relationships(text, entities)
    drafting = _classify_drafting(text, entities)
    architecture = _profile_architecture(text, entities, relationships)
    return SemanticAnalysis(entities, relationships, drafting, architecture)


# ── Entity extraction ────────────────────────────────────────────────────

def _overlaps(start: int, end: int, entities: list[Entity]) -> bool:
    return any(start < e.end and end > e.start for e in entities)


def _extract_entities(text: str) -> list[Entity]:
    entities: list[Entity] = []
    text_lower = text.lower()

    for name, etype in _NAMED_TECHNOLOGIES.items():
        for m in re.finditer(r"\b" + re.escape(name) + r"\b", text_lower):
            if not _overlaps(m.start(), m.end(), entities):
                entities.append(Entity(
                    name=text[m.start():m.end()],
                    entity_type=etype, confidence=0.95,
                    start=m.start(), end=m.end(),
                ))

    for phrase, etype in _MULTI_WORD_ENTITIES:
        for m in re.finditer(r"\b" + re.escape(phrase) + r"\b", text_lower):
            if not _overlaps(m.start(), m.end(), entities):
                entities.append(Entity(
                    name=text[m.start():m.end()],
                    entity_type=etype, confidence=0.90,
                    start=m.start(), end=m.end(),
                ))

    for suffix, etype in _ENTITY_SUFFIXES.items():
        for m in re.finditer(r"\b(\w+)\s+" + re.escape(suffix) + r"\b", text_lower):
            if not _overlaps(m.start(), m.end(), entities):
                entities.append(Entity(
                    name=text[m.start():m.end()],
                    entity_type=etype, confidence=0.85,
                    start=m.start(), end=m.end(),
                ))

    for keyword, etype in _BARE_ENTITY_KEYWORDS.items():
        for m in re.finditer(r"\b" + re.escape(keyword) + r"\b", text_lower):
            if not _overlaps(m.start(), m.end(), entities):
                entities.append(Entity(
                    name=text[m.start():m.end()],
                    entity_type=etype, confidence=0.60,
                    start=m.start(), end=m.end(),
                ))

    return sorted(entities, key=lambda e: e.start)


# ── Relationship extraction ──────────────────────────────────────────────

def _extract_relationships(
    text: str,
    entities: list[Entity],
) -> list[Relationship]:
    relationships: list[Relationship] = []
    for pattern, rel_type, verb_label in _RELATIONSHIP_VERBS:
        for m in pattern.finditer(text):
            verb_pos = m.start()
            source = None
            for e in reversed(entities):
                if e.end <= verb_pos:
                    source = e
                    break
            target = None
            for e in entities:
                if e.start >= m.end():
                    target = e
                    break
            if source and target:
                relationships.append(Relationship(
                    source=source.name, target=target.name,
                    verb=verb_label, rel_type=rel_type,
                ))
    return relationships


# ── Drafting intent classification ───────────────────────────────────────

def _identify_active_thought(text: str) -> str:
    segments = re.split(r"[.;!?\n]+", text)
    for seg in reversed(segments):
        stripped = seg.strip()
        if stripped:
            return stripped
    return text.strip()


def _classify_drafting(text: str, entities: list[Entity]) -> DraftingIntent:
    active_thought = _identify_active_thought(text)
    text_stripped = text.strip()

    ends_with_verb = bool(_TRAILING_VERB_RE.search(text_stripped))
    ends_with_prep = bool(_TRAILING_PREP_RE.search(text_stripped))

    last_entity: Entity | None = None
    ends_with_entity = False
    if entities:
        last_e = entities[-1]
        if len(text_stripped) - last_e.end <= 5:
            ends_with_entity = True
            last_entity = last_e

    ends_with_complete = bool(re.search(r"[.;!?]\s*$", text_stripped))

    word_count = len(text_stripped.split())
    if ends_with_complete:
        completeness = 1.0
    elif ends_with_verb or ends_with_prep:
        completeness = 0.6
    elif ends_with_entity:
        completeness = 0.4
    elif word_count < 3:
        completeness = 0.1
    else:
        completeness = 0.5

    text_lower = text_stripped.lower()
    if any(marker in text_lower for marker in ["\n-", "\n\u2022", "\n*", "1.", "2.", "3."]):
        intent = "listing"
    elif any(w in text_lower for w in ["then", "next", "after", "before", "first", "finally"]):
        intent = "sequencing"
    elif len(entities) > 4:
        intent = "specifying"
    elif word_count < 10 and len(entities) <= 2:
        intent = "brainstorming"
    else:
        intent = "specifying"

    last_verb_type: str | None = None
    if ends_with_verb or ends_with_prep:
        for pattern, rel_type, _ in _RELATIONSHIP_VERBS:
            if pattern.search(active_thought):
                last_verb_type = rel_type
                break

    return DraftingIntent(
        intent=intent,
        active_thought=active_thought,
        thought_completeness=completeness,
        ends_with_entity=ends_with_entity,
        ends_with_verb=ends_with_verb or ends_with_prep,
        ends_with_preposition=ends_with_prep,
        ends_with_complete_clause=ends_with_complete,
        last_entity=last_entity,
        last_verb_type=last_verb_type,
    )


# ── Architecture profiling ───────────────────────────────────────────────

def _profile_architecture(
    text: str,
    entities: list[Entity],
    relationships: list[Relationship],
) -> ArchitectureProfile:
    text_lower = text.lower()

    pattern_scores: dict[str, int] = {}
    for pattern_name, keywords in _ARCHITECTURE_SIGNALS.items():
        score = sum(1 for kw in keywords if kw in text_lower)
        if score > 0:
            pattern_scores[pattern_name] = score
    pattern = max(pattern_scores.keys(), key=lambda k: pattern_scores[k]) if pattern_scores else "unknown"

    entity_types = {e.entity_type for e in entities}
    has_data_stores = "data_store" in entity_types
    has_external = "external" in entity_types
    has_actors = "actor" in entity_types
    has_failure = any(kw in text_lower for kw in _FAILURE_KEYWORDS)

    entity_count = len(entities)
    rel_count = len(relationships)
    if entity_count >= 5 and rel_count >= 3:
        maturity = "mature"
    elif entity_count >= 2 and rel_count >= 1:
        maturity = "developing"
    else:
        maturity = "nascent"

    # ── Simple Idea Quality Score (SIQS) 0-100 ──
    score = 0
    if entity_count >= 5:
        score += 25
    elif entity_count >= 3:
        score += 18
    elif entity_count >= 1:
        score += 10

    specific_entities = sum(1 for e in entities if e.confidence >= 0.85)
    score += min(10, specific_entities * 3)

    if rel_count >= 4:
        score += 25
    elif rel_count >= 2:
        score += 18
    elif rel_count >= 1:
        score += 10

    if any(r.rel_type in ("data_flow", "routing", "event") for r in relationships):
        score += 15
    elif relationships:
        score += 8

    type_diversity = len(entity_types)
    score += min(15, type_diversity * 5)

    high_conf = sum(1 for e in entities if e.confidence >= 0.90)
    score += min(10, high_conf * 4)

    keyword_bonus = min(10, sum(2 for kw in _ARCH_BONUS_KEYWORDS if kw in text_lower))
    score += keyword_bonus

    if pattern_scores:
        best_pattern_score = max(pattern_scores.values())
        score += min(15, best_pattern_score * 4)

    return ArchitectureProfile(
        pattern=pattern,
        maturity=maturity,
        has_failure_paths=has_failure,
        has_data_stores=has_data_stores,
        has_external_systems=has_external,
        has_actors=has_actors,
        entity_count=entity_count,
        relationship_count=rel_count,
        quality_score=min(100, score),
    )
