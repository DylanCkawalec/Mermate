"""
MERMATE GoT Context Refinement Gateway — Python Runtime

Implements the bounded Graph-of-Thought prompt refinement pipeline
from meta.md as a FastAPI service. Provides:

  1. /refine      — single-shot prompt refinement (GoT search + merge)
  2. /score       — score a candidate prompt against msg + memory
  3. /audit       — audit a completed run JSON for prompt quality
  4. /cron/optimize — re-optimize all cached stage prompts
  5. /health      — liveness probe

Matrix scoring uses cosine similarity in a lightweight term-frequency
vector space. Manifold mixing blends multiple candidate prompts using
a convex combination weighted by their GoT scores.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from collections import Counter
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ---- Configuration ----------------------------------------------------------

GOT_DEPTH_CAP = int(os.getenv("META_GOT_DEPTH", "3"))
GOT_MAX_BRANCH = int(os.getenv("META_GOT_BRANCH", "3"))
GOT_NODE_BUDGET = int(os.getenv("META_GOT_BUDGET", "40"))
GOT_PRUNE_THRESHOLD = float(os.getenv("META_GOT_PRUNE", "0.85"))
RUNS_DIR = Path(os.getenv("MERMATE_RUNS_DIR", str(Path(__file__).resolve().parent.parent / "runs")))
PROMPTS_CACHE_DIR = Path(os.getenv("META_PROMPTS_CACHE", str(Path(__file__).resolve().parent / "prompt_cache")))

# ---- Vector Space for Term-Frequency Scoring --------------------------------

INTENT_TERMS = frozenset([
    "intent", "goal", "align", "msg", "validate", "validator", "score",
    "benchmark", "bounded", "depth", "branch", "budget", "prune",
    "merge", "artifact", "constraint", "stage", "pipeline", "render",
    "compile", "verify", "invariant", "coverage", "deterministic",
    "structured", "observable", "traceable", "truthful",
])

NOISE_TERMS = frozenset([
    "please", "kindly", "maybe", "perhaps", "honestly", "basically",
    "actually", "literally", "just", "really", "simply", "obviously",
])


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z_]\w+", text.lower())


def term_frequency_vector(tokens: list[str], vocab: frozenset[str]) -> dict[str, float]:
    counts = Counter(tokens)
    total = max(len(tokens), 1)
    return {term: counts.get(term, 0) / total for term in vocab}


def cosine_similarity(a: dict[str, float], b: dict[str, float]) -> float:
    keys = set(a) | set(b)
    dot = sum(a.get(k, 0) * b.get(k, 0) for k in keys)
    mag_a = math.sqrt(sum(v * v for v in a.values())) or 1e-9
    mag_b = math.sqrt(sum(v * v for v in b.values())) or 1e-9
    return dot / (mag_a * mag_b)


def noise_ratio(tokens: list[str]) -> float:
    if not tokens:
        return 0.0
    noise_count = sum(1 for t in tokens if t in NOISE_TERMS)
    return noise_count / len(tokens)


# ---- Thought Node -----------------------------------------------------------

@dataclass
class ThoughtNode:
    id: str
    depth: int
    hypothesis: str
    refined_prompt: str
    score: float = 0.0
    evidence: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    pruned: bool = False
    parent_id: Optional[str] = None


# ---- Scoring Engine ---------------------------------------------------------

def score_candidate(prompt: str, msg: str, original_goal: str) -> ThoughtNode:
    """Score a refined prompt against msg using multi-factor matrix."""
    prompt_tokens = tokenize(prompt)
    msg_tokens = tokenize(msg)

    prompt_vec = term_frequency_vector(prompt_tokens, INTENT_TERMS)
    msg_vec = term_frequency_vector(msg_tokens, INTENT_TERMS)

    evidence = []
    reasons = []
    score = 0.0

    # Factor 1: Intent-term cosine similarity (0-0.30)
    sim = cosine_similarity(prompt_vec, msg_vec)
    factor_1 = sim * 0.30
    score += factor_1
    if sim > 0.5:
        evidence.append(f"Intent cosine similarity: {sim:.3f}")
    else:
        reasons.append(f"Low intent alignment: {sim:.3f}")

    # Factor 2: msg anchoring (0-0.15)
    if "msg" in prompt.lower():
        score += 0.15
        evidence.append("Explicit msg anchoring")
    else:
        reasons.append("No msg anchoring")

    # Factor 3: Bounded topology language (0-0.15)
    bounded_terms = {"bounded", "depth", "branch", "budget", "prune", "merge"}
    bounded_count = sum(1 for t in prompt_tokens if t in bounded_terms)
    factor_3 = min(bounded_count / 6, 1.0) * 0.15
    score += factor_3
    if factor_3 > 0.08:
        evidence.append(f"Bounded topology terms: {bounded_count}/6")
    else:
        reasons.append("Weak topology discipline")

    # Factor 4: Validation language (0-0.12)
    val_terms = {"validate", "validator", "score", "benchmark", "invariant", "coverage"}
    val_count = sum(1 for t in prompt_tokens if t in val_terms)
    factor_4 = min(val_count / 4, 1.0) * 0.12
    score += factor_4
    if factor_4 > 0.06:
        evidence.append(f"Validation terms: {val_count}")

    # Factor 5: Goal binding (0-0.10)
    goal_prefix = original_goal[:min(32, len(original_goal))].lower()
    if goal_prefix and goal_prefix in prompt.lower():
        score += 0.10
        evidence.append("Lexical goal binding")

    # Factor 6: Context richness (0-0.08)
    if len(prompt) > 600:
        score += 0.05
        evidence.append("Rich context scaffold")
    if len(prompt) > 1200:
        score += 0.03
        evidence.append("Deep context scaffold")

    # Factor 7: Noise penalty (-0.10 max)
    nr = noise_ratio(prompt_tokens)
    if nr > 0.05:
        penalty = min(nr * 2, 0.10)
        score -= penalty
        reasons.append(f"Noise ratio: {nr:.3f} (-{penalty:.3f})")

    score = max(0.0, min(1.0, score))

    return ThoughtNode(
        id="",
        depth=0,
        hypothesis="",
        refined_prompt=prompt,
        score=score,
        evidence=evidence,
        reasons=reasons,
    )


# ---- Mutation Strategies ----------------------------------------------------

MUTATIONS = [
    lambda base, msg: base + f"\n\nACTIVE MSG WINDOW\nmsg = \"\"\"{msg[:500]}\"\"\"\n\nOPERATIVE LAW\n- Never answer away from msg\n- Keep msg visible during reasoning\n- Replace weak terms with context-fit terms\n- Refine toward executable clarity\n",
    lambda base, msg: base + "\n\nINFERENCE REFINEMENT LOOP\n1. Parse msg\n2. Extract intent, constraints, deliverable\n3. Generate bounded alternatives\n4. Score each against msg\n5. Select strongest aligned candidate\n6. Produce the final artifact\n",
    lambda base, msg: base + "\n\nMETA-BEHAVIOR\n- You are the gateway layer\n- You maintain wakefulness across state transitions\n- You optimize the next word for intent-fit, not likelihood\n- Every pass must improve validity or alignment\n",
    lambda base, msg: base + "\n\nLOCAL LLM CONTRACT\n- Prefer deterministic formatting\n- Prefer structured outputs\n- Prefer bounded search over theatrical verbosity\n- Keep token budget lean\n",
]


def mutate_prompt(base: str, msg: str, variant: int) -> str:
    return MUTATIONS[variant % len(MUTATIONS)](base, msg)


# ---- GoT Search -------------------------------------------------------------

def explore_thought_graph(
    seed_prompt: str,
    msg: str,
    original_goal: str,
) -> list[ThoughtNode]:
    nodes: list[ThoughtNode] = []
    created = 0

    root = score_candidate(seed_prompt, msg, original_goal)
    root.id = "S0"
    root.depth = 0
    root.hypothesis = "seed scaffold"
    nodes.append(root)
    created += 1

    frontier = [root]

    for depth in range(1, GOT_DEPTH_CAP + 1):
        next_frontier: list[ThoughtNode] = []
        for parent in frontier:
            for b in range(GOT_MAX_BRANCH):
                if created >= GOT_NODE_BUDGET:
                    break
                refined = mutate_prompt(parent.refined_prompt, msg, b + depth)
                node = score_candidate(refined, msg, original_goal)
                node.id = f"{parent.id}.{b+1}"
                node.parent_id = parent.id
                node.depth = depth
                node.hypothesis = f"mut-{b+1}-d{depth}"
                node.pruned = node.score < GOT_PRUNE_THRESHOLD
                nodes.append(node)
                created += 1
                if not node.pruned:
                    next_frontier.append(node)
        frontier = next_frontier
        if not frontier:
            break

    return nodes


# ---- Manifold Mixing (convex combination of top-k prompts) -----------------

def manifold_mix(nodes: list[ThoughtNode], k: int = 3) -> ThoughtNode:
    """Blend top-k prompts using score-weighted convex combination.

    For text, we concatenate with provenance markers and compute a
    blended score. The 'manifold' is the score-weighted simplex over
    the top-k candidates.
    """
    survivors = sorted([n for n in nodes if not n.pruned], key=lambda n: -n.score)[:k]
    if not survivors:
        survivors = sorted(nodes, key=lambda n: -n.score)[:k]

    total_score = sum(n.score for n in survivors) or 1.0
    weights = [n.score / total_score for n in survivors]

    parts = []
    for w, node in zip(weights, survivors):
        parts.append(f"## [{node.id}] weight={w:.3f} score={node.score:.3f}\n{node.refined_prompt}")

    merged_prompt = "\n\n---MANIFOLD-MIX---\n\n".join(parts)
    merged_score = min(1.0, sum(w * n.score for w, n in zip(weights, survivors)) + 0.03)

    return ThoughtNode(
        id="Sigma-Mix",
        depth=max(n.depth for n in survivors),
        hypothesis="manifold-mixed merge",
        refined_prompt=merged_prompt,
        score=merged_score,
        evidence=[
            f"Mixed {len(survivors)} candidates",
            f"Weights: {[f'{w:.3f}' for w in weights]}",
            "Provenance preserved",
        ],
        reasons=[],
    )


# ---- Run Auditor ------------------------------------------------------------

def audit_run(run_data: dict) -> dict:
    """Score a completed run JSON for prompt-outcome quality."""
    calls = run_data.get("agent_calls", [])
    totals = run_data.get("totals", {})
    final = run_data.get("final_artifact", {})

    total_calls = len(calls)
    total_cost = totals.get("total_cost_est", 0)
    total_tokens = totals.get("total_tokens_in", 0) + totals.get("total_tokens_out", 0)
    wall_ms = totals.get("wall_clock_ms", 0)

    has_final = final is not None
    node_count = final.get("metrics", {}).get("node_count", 0) if final else 0
    edge_count = final.get("metrics", {}).get("edge_count", 0) if final else 0

    efficiency = (node_count + edge_count) / max(total_tokens, 1) * 1000
    cost_per_node = total_cost / max(node_count, 1)

    score = 0.0
    findings = []

    if has_final:
        score += 0.3
        findings.append("Final artifact produced")
    else:
        findings.append("WARN: No final artifact")

    if total_calls <= 6:
        score += 0.2
        findings.append(f"Efficient call count: {total_calls}")
    elif total_calls <= 12:
        score += 0.1
        findings.append(f"Moderate call count: {total_calls}")
    else:
        findings.append(f"High call count: {total_calls}")

    if wall_ms < 30000:
        score += 0.2
        findings.append(f"Fast wall clock: {wall_ms}ms")
    elif wall_ms < 60000:
        score += 0.1

    if efficiency > 0.5:
        score += 0.15
        findings.append(f"High token efficiency: {efficiency:.3f} nodes+edges/1k tokens")

    if cost_per_node < 0.01:
        score += 0.15
        findings.append(f"Low cost per node: ${cost_per_node:.4f}")

    return {
        "run_id": run_data.get("run_id"),
        "score": round(min(1.0, score), 3),
        "findings": findings,
        "metrics": {
            "total_calls": total_calls,
            "total_tokens": total_tokens,
            "total_cost": total_cost,
            "wall_ms": wall_ms,
            "node_count": node_count,
            "edge_count": edge_count,
            "efficiency": round(efficiency, 4),
            "cost_per_node": round(cost_per_node, 6),
        },
    }


# ---- FastAPI Service --------------------------------------------------------

app = FastAPI(title="MERMATE Meta-Cognition Gateway", version="1.0.0")


class RefineRequest(BaseModel):
    msg: str
    seed_prompt: str = ""
    original_goal: str = ""
    history: list[dict] = []


class ScoreRequest(BaseModel):
    prompt: str
    msg: str
    original_goal: str = ""


class AuditRequest(BaseModel):
    run_id: str


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "meta-cognition-gateway",
        "got_config": {
            "depth": GOT_DEPTH_CAP,
            "branch": GOT_MAX_BRANCH,
            "budget": GOT_NODE_BUDGET,
            "prune": GOT_PRUNE_THRESHOLD,
        },
    }


@app.post("/refine")
def refine(req: RefineRequest):
    start = time.time()
    seed = req.seed_prompt or f"You are a bounded architecture inference engine.\n\nmsg: {req.msg[:500]}"
    goal = req.original_goal or req.msg

    nodes = explore_thought_graph(seed, req.msg, goal)
    best = max(nodes, key=lambda n: n.score)

    mixed = manifold_mix(nodes)
    if mixed.score >= best.score:
        best = mixed
        nodes.append(mixed)

    elapsed_ms = int((time.time() - start) * 1000)

    return {
        "success": True,
        "system_prompt": best.refined_prompt,
        "score": best.score,
        "node_id": best.id,
        "explored": len(nodes),
        "pruned": sum(1 for n in nodes if n.pruned),
        "elapsed_ms": elapsed_ms,
        "evidence": best.evidence,
        "benchmark": {
            "seed_score": nodes[0].score if nodes else 0,
            "best_score": best.score,
            "delta": round(best.score - (nodes[0].score if nodes else 0), 4),
            "nodes_explored": len(nodes),
        },
    }


@app.post("/score")
def score(req: ScoreRequest):
    node = score_candidate(req.prompt, req.msg, req.original_goal or req.msg)
    return {
        "score": node.score,
        "evidence": node.evidence,
        "reasons": node.reasons,
    }


@app.post("/audit")
def audit(req: AuditRequest):
    run_path = RUNS_DIR / f"{req.run_id}.json"
    if not run_path.exists():
        raise HTTPException(404, f"Run {req.run_id} not found")
    run_data = json.loads(run_path.read_text())
    return audit_run(run_data)


@app.post("/cron/optimize")
def cron_optimize():
    """Re-score all completed runs and produce aggregate prompt quality metrics."""
    if not RUNS_DIR.exists():
        return {"success": True, "runs_audited": 0, "findings": []}

    run_files = sorted(RUNS_DIR.glob("*.json"))[-20:]
    results = []
    for rf in run_files:
        try:
            run_data = json.loads(rf.read_text())
            if run_data.get("status") != "completed":
                continue
            results.append(audit_run(run_data))
        except Exception:
            continue

    if not results:
        return {"success": True, "runs_audited": 0, "findings": ["No completed runs found"]}

    avg_score = sum(r["score"] for r in results) / len(results)
    avg_calls = sum(r["metrics"]["total_calls"] for r in results) / len(results)
    avg_cost = sum(r["metrics"]["total_cost"] for r in results) / len(results)
    avg_efficiency = sum(r["metrics"]["efficiency"] for r in results) / len(results)

    return {
        "success": True,
        "runs_audited": len(results),
        "aggregate": {
            "avg_score": round(avg_score, 3),
            "avg_calls": round(avg_calls, 1),
            "avg_cost": round(avg_cost, 6),
            "avg_efficiency": round(avg_efficiency, 4),
        },
        "recommendations": _generate_recommendations(avg_score, avg_calls, avg_efficiency),
        "per_run": results,
    }


def _generate_recommendations(avg_score: float, avg_calls: float, avg_efficiency: float) -> list[str]:
    recs = []
    if avg_score < 0.5:
        recs.append("CRITICAL: Average run quality below 0.5 -- review prompt templates and fact extraction")
    if avg_calls > 10:
        recs.append("HIGH: Average call count >10 -- consider tighter stage routing or skipping redundant repair loops")
    if avg_efficiency < 0.3:
        recs.append("MEDIUM: Low token efficiency -- prompts may be over-specified or models over-generating")
    if avg_score >= 0.7 and avg_calls <= 6:
        recs.append("GOOD: Pipeline is efficient and producing quality results")
    return recs


# ---- Entry point for uvicorn ------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("META_GATEWAY_PORT", "8200"))
    uvicorn.run(app, host="0.0.0.0", port=port)
