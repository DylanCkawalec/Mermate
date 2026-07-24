"""Structured NDJSON runtime logger for MCP tool calls.

Every tool invocation — whether it hits Mermate Express, OpenClaw, the TLA+
harness, or Opseeq — is logged as one JSON line to a rotating file.

Log entry shape:
  {
    "ts": "2026-07-24T17:21:00.123Z",
    "tool": "mermate_render",
    "gateway": "mermate",          // mermate | openclaw | harness | opseeq | internal
    "method": "POST",
    "path": "/api/render",
    "args_summary": {...},          // truncated key args, never full payload
    "status": "ok",                 // ok | error | timeout
    "duration_ms": 342,
    "result_summary": {...}         // truncated result metadata
  }
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = Path(os.environ.get("MERMATE_MCP_LOG_DIR", str(PROJECT_ROOT / "logs")))
LOG_FILE = LOG_DIR / "mcp-runtime.jsonl"
MAX_FILE_BYTES = int(os.environ.get("MERMATE_MCP_LOG_MAX_BYTES", str(10 * 1024 * 1024)))
MAX_ENTRIES = int(os.environ.get("MERMATE_MCP_LOG_MAX_ENTRIES", "5000"))

_ensure_dir_done = False


def _ensure_dir() -> None:
    global _ensure_dir_done
    if not _ensure_dir_done:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        _ensure_dir_done = True


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _truncate(obj: Any, max_items: int = 8, max_str: int = 200) -> Any:
    """Truncate nested structures for log summaries — never log full payloads."""
    if isinstance(obj, dict):
        if len(obj) > max_items:
            keys = list(obj.keys())[:max_items]
            return {k: _truncate(obj[k], max_items, max_str) for k in keys} | {"_truncated": len(obj) - max_items}
        return {k: _truncate(v, max_items, max_str) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        if len(obj) > max_items:
            return [_truncate(x, max_items, max_str) for x in obj[:max_items]] + [f"...+{len(obj) - max_items}"]
        return [_truncate(x, max_items, max_str) for x in obj]
    if isinstance(obj, str) and len(obj) > max_str:
        return obj[:max_str] + f"...+{len(obj) - max_str}"
    return obj


def log_event(
    tool: str,
    gateway: str,
    *,
    method: str = "",
    path: str = "",
    args: dict[str, Any] | None = None,
    status: str = "ok",
    duration_ms: float = 0,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Append one structured event to the NDJSON runtime log."""
    _ensure_dir()
    entry: dict[str, Any] = {
        "ts": _now_iso(),
        "tool": tool,
        "gateway": gateway,
        "method": method,
        "path": path,
        "args_summary": _truncate(args) if args else {},
        "status": status,
        "duration_ms": round(duration_ms, 1),
    }
    if result is not None:
        entry["result_summary"] = _truncate(result)
    if error:
        entry["error"] = error[:500]

    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass  # logging must never break the tool call

    _maybe_rotate()


def _maybe_rotate() -> None:
    """Rotate if file exceeds MAX_FILE_BYTES — keep last half."""
    try:
        size = LOG_FILE.stat().st_size
        if size <= MAX_FILE_BYTES:
            return
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
        keep = lines[len(lines) // 2 :]
        LOG_FILE.write_text("\n".join(keep) + "\n", encoding="utf-8")
    except Exception:
        pass


def get_recent(
    limit: int = 50,
    tool: str | None = None,
    gateway: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """Read recent log entries, newest first, with optional filters."""
    if not LOG_FILE.exists():
        return []
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []

    results: list[dict[str, Any]] = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if tool and entry.get("tool") != tool:
            continue
        if gateway and entry.get("gateway") != gateway:
            continue
        if status and entry.get("status") != status:
            continue
        results.append(entry)
        if len(results) >= limit:
            break
    return results


def get_stats() -> dict[str, Any]:
    """Aggregate stats over the log — tool call counts, error rates, avg duration."""
    entries = get_recent(limit=MAX_ENTRIES)
    if not entries:
        return {"total_calls": 0, "tools": {}, "gateways": {}, "error_count": 0, "error_rate": 0}

    tool_counts: dict[str, int] = {}
    gateway_counts: dict[str, int] = {}
    error_count = 0
    durations: list[float] = []

    for e in entries:
        t = e.get("tool", "unknown")
        tool_counts[t] = tool_counts.get(t, 0) + 1
        g = e.get("gateway", "unknown")
        gateway_counts[g] = gateway_counts.get(g, 0) + 1
        if e.get("status") == "error":
            error_count += 1
        d = e.get("duration_ms", 0)
        if isinstance(d, (int, float)):
            durations.append(d)

    avg_ms = sum(durations) / len(durations) if durations else 0
    p95_ms = sorted(durations)[int(len(durations) * 0.95)] if len(durations) > 1 else 0

    return {
        "total_calls": len(entries),
        "tools": dict(sorted(tool_counts.items(), key=lambda x: -x[1])),
        "gateways": dict(sorted(gateway_counts.items(), key=lambda x: -x[1])),
        "error_count": error_count,
        "error_rate": round(error_count / len(entries), 4),
        "avg_duration_ms": round(avg_ms, 1),
        "p95_duration_ms": round(p95_ms, 1),
        "log_file": str(LOG_FILE),
    }


def clear() -> int:
    """Clear the log file. Returns number of entries removed."""
    if not LOG_FILE.exists():
        return 0
    try:
        count = sum(1 for _ in LOG_FILE.open(encoding="utf-8"))
        LOG_FILE.write_text("", encoding="utf-8")
        return count
    except Exception:
        return 0
