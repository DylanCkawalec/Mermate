"""Agent context memory for MCP tool calls.

Persists key state across tool invocations so the AI model can recall
run_ids, diagram names, stage progressions, stage previews (source text),
and recent results without re-calling the backend.

Two layers:
  1. Per-session context: each MCP session gets its own context dict,
     keyed by session_id. The active session is used by default.
  2. Stage previews: each pipeline stage's output source is captured
     (mermaid_source, tla_source, ts_source, rust_source, markdown_source)
     so the AI can inspect what was produced without re-calling the API.

Auto-extraction: when a tool result contains run_id, diagram_name, stage,
or success fields, they are automatically remembered.

Manual API: remember(key, value), recall(key), snapshot(), clear().
Session API: set_session(), get_session(), list_sessions(), clear_session().
Preview API: get_preview(stage), get_all_previews(), clear_previews().
"""

from __future__ import annotations

import time
import uuid
from typing import Any

# ---- Well-known field extraction ---------------------------------------------

_well_known_extract: dict[str, list[str]] = {
    "run_id": ["run_id", "runId"],
    "diagram_name": ["diagram_name", "diagramName"],
    "stage": ["stage", "current_stage"],
    "tla_valid": ["sany_valid", "valid", "sany", "tlc_success"],
}

# ---- Stage preview field mapping ---------------------------------------------
# Maps a pipeline stage to the result fields that contain its source text.

_stage_preview_fields: dict[str, list[str]] = {
    "render": ["compiled_source", "mermaid_source", "markdown_source", "enhanced_source"],
    "tla": ["tla_source", "cfg_source"],
    "ts": ["ts_source", "harness_source"],
    "rust": ["rust_source"],
    "tsx": ["tsx_source"],
}

# Maps tool names to pipeline stages for preview extraction

_tool_stage_map: dict[str, str] = {
    "mermate_render": "render",
    "mermate_render_tla": "tla",
    "mermate_tla_edit": "tla",
    "mermate_tla_revalidate": "tla",
    "mermate_tla_check": "tla",
    "mermate_render_ts": "ts",
    "mermate_render_ts_source": "ts",
    "mermate_render_rust": "rust",
    "mermate_render_tsx": "tsx",
    "tla_harness_sany": "tla",
    "tla_harness_tlc": "tla",
    "tla_harness_pluscal": "tla",
    "tla_harness_latex": "tla",
}

# ---- Session management ------------------------------------------------------

_sessions: dict[str, dict[str, Any]] = {}
_active_session_id: str | None = None


def set_session(session_id: str | None = None) -> str:
    """Set the active session. Creates a new one if None or unknown."""
    global _active_session_id
    if session_id and session_id in _sessions:
        _active_session_id = session_id
    else:
        session_id = session_id or str(uuid.uuid4())
        _sessions[session_id] = {
            "context": {},
            "history": [],
            "previews": {},
            "created_ts": time.time(),
        }
        _active_session_id = session_id
    return _active_session_id


def get_session() -> str | None:
    return _active_session_id


def list_sessions() -> list[dict[str, Any]]:
    """List all sessions with metadata."""
    result = []
    for sid, data in _sessions.items():
        result.append({
            "session_id": sid,
            "active": sid == _active_session_id,
            "context_keys": list(data["context"].keys()),
            "preview_stages": list(data["previews"].keys()),
            "history_count": len(data["history"]),
            "created_ts": data["created_ts"],
        })
    return result


def clear_session(session_id: str | None = None) -> bool:
    """Clear a specific session, or the active one if None."""
    global _active_session_id
    sid = session_id or _active_session_id
    if sid and sid in _sessions:
        del _sessions[sid]
        if sid == _active_session_id:
            _active_session_id = None
        return True
    return False


def _ensure_session() -> dict[str, Any]:
    """Get the active session data, creating one if needed."""
    if _active_session_id is None or _active_session_id not in _sessions:
        set_session()
    return _sessions[_active_session_id]


# ---- Context access (delegates to active session) ---------------------------

def remember(key: str, value: Any) -> None:
    session = _ensure_session()
    session["context"][key] = value


def recall(key: str, default: Any = None) -> Any:
    session = _ensure_session()
    return session["context"].get(key, default)


def forget(key: str) -> bool:
    session = _ensure_session()
    return session["context"].pop(key, None) is not None


def snapshot() -> dict[str, Any]:
    session = _ensure_session()
    return dict(session["context"])


def history(limit: int = 20) -> list[dict[str, Any]]:
    session = _ensure_session()
    return session["history"][-limit:]


def clear() -> None:
    """Clear the active session's context and history."""
    session = _ensure_session()
    session["context"].clear()
    session["history"].clear()
    session["previews"].clear()


def clear_all() -> None:
    """Clear all sessions."""
    global _active_session_id
    _sessions.clear()
    _active_session_id = None


# ---- Stage previews ----------------------------------------------------------

def _extract_previews(tool: str, result: dict[str, Any]) -> dict[str, str]:
    """Extract source text previews from a tool result based on its stage."""
    stage = _tool_stage_map.get(tool)
    if not stage:
        return {}
    fields = _stage_preview_fields.get(stage, [])
    previews: dict[str, str] = {}
    for field in fields:
        val = result.get(field)
        if isinstance(val, str) and val.strip():
            previews[field] = val
    return previews


def get_preview(stage: str) -> dict[str, str] | None:
    """Get the captured preview for a specific pipeline stage."""
    session = _ensure_session()
    return session["previews"].get(stage)


def get_all_previews() -> dict[str, dict[str, str]]:
    """Get all captured stage previews for the active session."""
    session = _ensure_session()
    return dict(session["previews"])


def clear_previews() -> None:
    session = _ensure_session()
    session["previews"].clear()


# ---- Core observe function ---------------------------------------------------

def _extract_from_result(result: dict[str, Any]) -> dict[str, Any]:
    """Auto-extract well-known fields from a tool result."""
    extracted: dict[str, Any] = {}
    for canonical, keys in _well_known_extract.items():
        for k in keys:
            if k in result and result[k] is not None:
                extracted[canonical] = result[k]
                break
    return extracted


def observe(tool: str, args: dict[str, Any], result: dict[str, Any], gateway: str = "") -> None:
    """Called after every tool execution. Extracts context, previews, and records history."""
    ts = time.time()
    session = _ensure_session()
    ctx = session["context"]

    # Auto-extract well-known fields from result
    extracted = _extract_from_result(result)
    for k, v in extracted.items():
        ctx[k] = v

    # Also extract from args (run_id, diagram_name are often in args)
    for canonical, keys in _well_known_extract.items():
        if canonical in ctx:
            continue
        for k in keys:
            if k in args and args[k] is not None:
                ctx[canonical] = args[k]
                break

    # Track last tool call
    ctx["last_tool"] = tool
    ctx["last_gateway"] = gateway
    ctx["last_call_ts"] = ts

    # Track stage progression
    stage = _tool_stage_map.get(tool) or extracted.get("stage")
    if stage:
        stages = ctx.get("stage_history", [])
        stages.append({"stage": stage, "tool": tool, "ts": ts})
        ctx["stage_history"] = stages[-20:]
        ctx["current_stage"] = stage

    # Extract and store stage previews (source text)
    previews = _extract_previews(tool, result)
    if previews:
        stage_key = _tool_stage_map[tool]
        existing = session["previews"].get(stage_key, {})
        existing.update(previews)
        session["previews"][stage_key] = existing

    # Track success/failure counts
    success = result.get("success", None)
    if success is not None:
        ctx["calls"] = ctx.get("calls", 0) + 1
        if success:
            ctx["ok_calls"] = ctx.get("ok_calls", 0) + 1
        else:
            ctx["err_calls"] = ctx.get("err_calls", 0) + 1

    # Append to history (compact)
    session["history"].append({
        "ts": ts,
        "tool": tool,
        "gateway": gateway,
        "ok": bool(success) if success is not None else None,
        "run_id": extracted.get("run_id", args.get("run_id")),
        "stage": stage,
    })
    if len(session["history"]) > 100:
        session["history"] = session["history"][-100:]


# ---- Summary -----------------------------------------------------------------

def get_context_summary() -> dict[str, Any]:
    """Rich context summary for the MCP controller observer."""
    session = _ensure_session()
    return {
        "session_id": _active_session_id,
        "context": dict(session["context"]),
        "recent_history": session["history"][-10:],
        "context_keys": list(session["context"].keys()),
        "previews": {
            stage: {k: v[:200] + "..." if len(v) > 200 else v for k, v in fields.items()}
            for stage, fields in session["previews"].items()
        },
        "preview_stages": list(session["previews"].keys()),
    }
