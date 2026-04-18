from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover - exercised only when dependency is missing
    raise SystemExit(
        "Missing Python dependency 'mcp[cli]'. Run `python3 -m pip install -r requirements.txt`."
    ) from exc

from .client import MermateClient, MermateHttpError, summarize_sse_events


SERVER_NAME = "mermate-openclaw-mcp"
SERVER_VERSION = "5.0.0"
DEFAULT_BASE_URL = os.environ.get("MERMATE_URL", "http://127.0.0.1:3333")
DEFAULT_OPENCLAW_URL = os.environ.get("OPENCLAW_URL", "http://127.0.0.1:8787")

DEFAULT_ROUTE_TIMEOUT_S = int(os.environ.get("MERMATE_MCP_HTTP_TIMEOUT_S", "30"))
DEFAULT_RENDER_TIMEOUT_S = int(os.environ.get("MERMATE_MCP_RENDER_TIMEOUT_S", "360"))
DEFAULT_TLA_TIMEOUT_S = int(os.environ.get("MERMATE_MCP_TLA_TIMEOUT_S", "240"))
DEFAULT_TS_TIMEOUT_S = int(os.environ.get("MERMATE_MCP_TS_TIMEOUT_S", "240"))
DEFAULT_AGENT_TIMEOUT_S = int(os.environ.get("MERMATE_MCP_AGENT_TIMEOUT_S", "900"))
DEFAULT_OPENCLAW_TIMEOUT_S = int(os.environ.get("OPENCLAW_MCP_HTTP_TIMEOUT_S", "120"))

STAGE_MAP = {
    "render": {
        "route": "/api/render",
        "description": "Idea, markdown, or Mermaid input compiled into a final Mermaid diagram bundle.",
        "next_stage": "tla",
    },
    "tla": {
        "route": "/api/render/tla",
        "description": "Generate and validate a TLA+ specification from a render run.",
        "requires": "run_id from /api/render",
        "next_stage": "ts",
        "management": {
            "check": "/api/render/tla/check — Quick SANY syntax check on raw TLA+ source",
            "errors": "/api/render/tla/errors/:run_id — Read structured SANY/TLC errors",
            "revalidate": "/api/render/tla/revalidate — Re-run SANY+TLC with repair on existing spec",
            "edit": "/api/render/tla/edit — Edit spec source, validate, and persist",
        },
    },
    "ts": {
        "route": "/api/render/ts",
        "description": "Generate and validate a TypeScript runtime from the TLA+ stage.",
        "requires": "run_id with persisted TLA+ artifacts",
    },
    "agent_preview": {
        "route": "/api/agent/run",
        "description": "SSE workflow that plans, refines, and produces a preview render before finalization.",
        "next_stage": "agent_finalize",
    },
    "agent_finalize": {
        "route": "/api/agent/finalize",
        "description": "SSE workflow that optionally applies notes and runs the final Max render.",
    },
    "project_pipeline": {
        "route": "/api/projects/:id/pipeline",
        "description": "Read the persisted pipeline progression and GoT metrics for a named project.",
    },
    "openclaw_application_protocol": {
        "route": "/api/architect/pipeline",
        "description": "Run the OpenClaw wrapper protocol: idea to architecture, optional TLA+, optional TypeScript, and optional scaffold.",
    },
}

TOOL_ROUTE_MAP = {
    "mermate_status": [
        "/api/copilot/health",
        "/api/render/tla/status",
        "/api/render/ts/status",
        "/api/agent/modes",
        "/api/meta/health",
        "/api/rate-master/metrics",
    ],
    "mermate_copilot": ["/api/copilot/enhance"],
    "mermate_visual_styles": ["/api/visual/styles"],
    "mermate_analyze": ["/api/analyze"],
    "mermate_render": ["/api/render"],
    "mermate_render_tla": ["/api/render/tla"],
    "mermate_tla_check": ["/api/render/tla/check"],
    "mermate_tla_errors": ["/api/render/tla/errors/:run_id"],
    "mermate_tla_revalidate": ["/api/render/tla/revalidate"],
    "mermate_tla_edit": ["/api/render/tla/edit"],
    "mermate_render_ts": ["/api/render/ts"],
    "mermate_full_pipeline": ["/api/render", "/api/render/tla", "/api/render/ts", "/api/projects/:id", "/api/projects/:id/pipeline"],
    "mermate_agent_modes": ["/api/agent/modes"],
    "mermate_agent_run": ["/api/agent/run"],
    "mermate_agent_finalize": ["/api/agent/finalize"],
    "mermate_agent_workflow": ["/api/agent/run", "/api/agent/finalize"],
    "mermate_list_diagrams": ["/api/diagrams"],
    "mermate_rename_diagram": ["/api/diagrams/:name"],
    "mermate_delete_diagram": ["/api/diagrams/:name"],
    "mermate_transcribe": ["/api/transcribe"],
    "mermate_list_projects": ["/api/projects"],
    "mermate_get_project": ["/api/projects/:id"],
    "mermate_get_project_history": ["/api/projects/:id/history"],
    "mermate_verify_project": ["/api/projects/:id/verify"],
    "mermate_get_project_pipeline": ["/api/projects/:id/pipeline"],
    "mermate_search": ["/api/search"],
    "mermate_scoreboard": ["/api/scoreboard"],
    "mermate_meta_refine": ["/api/meta/refine"],
    "mermate_meta_audit": ["/api/meta/audit"],
    "mermate_meta_cron": ["/api/meta/cron"],
    "mermate_agents": ["/api/agents"],
    "openclaw_status": ["/api/status"],
    "openclaw_chat": ["/api/chat"],
    "openclaw_connectivity_probe": ["/api/connectivity/probe"],
    "openclaw_architect_status": ["/api/architect/status"],
    "openclaw_application_protocol": ["/api/architect/pipeline"],
    "openclaw_builder_scaffold": ["/api/builder/scaffold"],
}

INSTRUCTIONS = (
    "Use this server to drive the local Mermate pipeline and the colocated OpenClaw wrapper from one MCP endpoint. "
    "Prefer the stage-specific tools for render, TLA+, TypeScript, agent flows, and the OpenClaw application-builder protocol. "
    "Treat the underlying Express routes as the source of truth."
)


mcp = FastMCP(
    SERVER_NAME,
    instructions=INSTRUCTIONS,
    json_response=True,
)


def create_client() -> MermateClient:
    return MermateClient(base_url=DEFAULT_BASE_URL, timeout_s=DEFAULT_ROUTE_TIMEOUT_S)


def create_openclaw_client() -> MermateClient:
    return MermateClient(base_url=DEFAULT_OPENCLAW_URL, timeout_s=DEFAULT_OPENCLAW_TIMEOUT_S)


def _normalize_input_mode(mode: str | None) -> str | None:
    if mode is None:
        return None
    lowered = mode.strip().lower()
    if lowered == "markdown":
        return "md"
    return lowered


def _normalize_api_error(exc: Exception, path: str) -> dict[str, Any]:
    if isinstance(exc, MermateHttpError):
        payload = exc.payload if isinstance(exc.payload, dict) else {"message": str(exc.payload)}
        return {
            "success": False,
            "status": exc.status,
            "path": path,
            **payload,
        }

    return {
        "success": False,
        "status": None,
        "path": path,
        "error": "mcp_bridge_error",
        "details": str(exc),
    }


def _call_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    client = create_client()
    try:
        payload = client.request_json(method, path, body=body, query=query, timeout_s=timeout_s)
        return payload if isinstance(payload, dict) else {"success": True, "data": payload}
    except Exception as exc:
        return _normalize_api_error(exc, path)


def _call_openclaw_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    client = create_openclaw_client()
    try:
        payload = client.request_json(method, path, body=body, query=query, timeout_s=timeout_s)
        if isinstance(payload, dict):
            return {"base_url": DEFAULT_OPENCLAW_URL, **payload}
        return {"success": True, "base_url": DEFAULT_OPENCLAW_URL, "data": payload}
    except Exception as exc:
        normalized = _normalize_api_error(exc, path)
        return {"base_url": DEFAULT_OPENCLAW_URL, **normalized}


def _call_sse(path: str, *, body: dict[str, Any], timeout_s: int | None = None, include_events: bool = False) -> dict[str, Any]:
    client = create_client()
    try:
        events = client.stream_sse(path, body=body, timeout_s=timeout_s)
        summary = summarize_sse_events(events)
        if include_events:
            summary["events"] = events
        summary["success"] = not summary["errors"]
        return summary
    except Exception as exc:
        return _normalize_api_error(exc, path)


@mcp.resource(
    "mermate://stage-map",
    name="Mermate Stage Map",
    description="The live stage model exposed by this MCP bridge.",
    mime_type="application/json",
)
def stage_map_resource() -> str:
    return json.dumps(STAGE_MAP, indent=2)


@mcp.resource(
    "mermate://tool-routes",
    name="Mermate Tool Route Map",
    description="Maps MCP tool names to the underlying Express routes.",
    mime_type="application/json",
)
def tool_route_map_resource() -> str:
    return json.dumps(TOOL_ROUTE_MAP, indent=2)


@mcp.prompt(
    name="mermate_full_build_plan",
    description="Template for asking Mermate to build an architecture bundle end-to-end.",
)
def full_build_plan_prompt(source: str) -> str:
    return (
        "Use the Mermate MCP tools to turn this request into a render, then continue through TLA+ and "
        "TypeScript when the prior stage succeeds.\n\n"
        f"Source request:\n{source.strip()}"
    )


@mcp.tool(description="Inspect the local Mermate runtime, including copilot, TLA, TS, meta, and rate-master availability.")
def mermate_status() -> dict[str, Any]:
    return {
        "base_url": DEFAULT_BASE_URL,
        "copilot": _call_json("GET", "/api/copilot/health"),
        "tla": _call_json("GET", "/api/render/tla/status"),
        "ts": _call_json("GET", "/api/render/ts/status"),
        "agent_modes": _call_json("GET", "/api/agent/modes"),
        "meta": _call_json("GET", "/api/meta/health"),
        "rate_master": _call_json("GET", "/api/rate-master/metrics"),
    }


@mcp.tool(description="Run Mermate's deterministic input analyzer on idea, markdown, or Mermaid text.")
def mermate_analyze(
    text: str,
    mode: Literal["idea", "md", "markdown", "mmd"] = "idea",
) -> dict[str, Any]:
    return _call_json("POST", "/api/analyze", body={"text": text, "mode": _normalize_input_mode(mode)})


@mcp.tool(description="Call the copilot suggest or enhance action through the same contract used by the frontend.")
def mermate_copilot(
    stage: Literal["copilot_suggest", "copilot_enhance"],
    raw_source: str,
    full_text: str | None = None,
    selected_text: str | None = None,
    active_line: str | None = None,
    enhance_mode: str | None = None,
    content_state: str | None = None,
    mode: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    body = {
        "stage": stage,
        "raw_source": raw_source,
        "full_text": full_text,
        "selected_text": selected_text,
        "active_line": active_line,
        "enhance_mode": enhance_mode,
        "content_state": content_state,
        "mode": mode,
    }
    return _call_json("POST", "/api/copilot/enhance", body=body, timeout_s=timeout_s or DEFAULT_ROUTE_TIMEOUT_S)


@mcp.tool(description="Return the visual style presets currently available in the Mermate runtime.")
def mermate_visual_styles() -> dict[str, Any]:
    return _call_json("GET", "/api/visual/styles")


@mcp.tool(description="Compile idea, markdown, or Mermaid source through Mermate's render pipeline.")
def mermate_render(
    source: str,
    diagram_name: str | None = None,
    input_mode: Literal["idea", "md", "markdown", "mmd"] = "idea",
    enhance: bool = True,
    max_mode: bool = False,
    visual: bool = False,
    visual_style: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/render",
        body={
            "mermaid_source": source,
            "diagram_name": diagram_name,
            "input_mode": _normalize_input_mode(input_mode),
            "enhance": enhance,
            "max_mode": max_mode,
            "visual": visual,
            "visual_style": visual_style,
        },
        timeout_s=timeout_s or DEFAULT_RENDER_TIMEOUT_S,
    )


@mcp.tool(description="Generate and validate a TLA+ specification from an existing render run.")
def mermate_render_tla(
    run_id: str,
    diagram_name: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/render/tla",
        body={"run_id": run_id, "diagram_name": diagram_name},
        timeout_s=timeout_s or DEFAULT_TLA_TIMEOUT_S,
    )


@mcp.tool(description="Generate and validate a TypeScript runtime from an existing render run with TLA+ artifacts.")
def mermate_render_ts(
    run_id: str,
    diagram_name: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/render/ts",
        body={"run_id": run_id, "diagram_name": diagram_name},
        timeout_s=timeout_s or DEFAULT_TS_TIMEOUT_S,
    )


@mcp.tool(description="Quick SANY syntax check on raw TLA+ source without requiring a run_id. Returns parse errors immediately.")
def mermate_tla_check(
    tla_source: str,
    module_name: str = "CheckSpec",
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/render/tla/check",
        body={"tla_source": tla_source, "module_name": module_name},
        timeout_s=DEFAULT_TLA_TIMEOUT_S,
    )


@mcp.tool(description="Read structured TLA+ validation errors and metrics for an existing run. Use to inspect SANY/TLC results without re-running.")
def mermate_tla_errors(
    run_id: str,
) -> dict[str, Any]:
    return _call_json("GET", f"/api/render/tla/errors/{run_id}")


@mcp.tool(description="Re-run SANY + TLC validation on existing TLA+ artifacts with optional LLM repair. Does not regenerate the spec.")
def mermate_tla_revalidate(
    run_id: str,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/render/tla/revalidate",
        body={"run_id": run_id},
        timeout_s=timeout_s or DEFAULT_TLA_TIMEOUT_S,
    )


@mcp.tool(description="Edit a TLA+ spec source, validate it with SANY + TLC, and persist the result. Like a document save with automatic compilation.")
def mermate_tla_edit(
    run_id: str,
    tla_source: str,
    cfg_source: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"run_id": run_id, "tla_source": tla_source}
    if cfg_source:
        body["cfg_source"] = cfg_source
    return _call_json(
        "POST",
        "/api/render/tla/edit",
        body=body,
        timeout_s=timeout_s or DEFAULT_TLA_TIMEOUT_S,
    )


@mcp.tool(description="Run the core Mermate pipeline end to end: render, then optional TLA+, TypeScript, and persisted project status lookups.")
def mermate_full_pipeline(
    source: str,
    diagram_name: str | None = None,
    input_mode: Literal["idea", "md", "markdown", "mmd"] = "idea",
    enhance: bool = True,
    max_mode: bool = False,
    include_tla: bool = True,
    include_ts: bool = True,
    include_project_state: bool = True,
) -> dict[str, Any]:
    render_result = mermate_render(
        source=source,
        diagram_name=diagram_name,
        input_mode=input_mode,
        enhance=enhance,
        max_mode=max_mode,
    )

    run_id = render_result.get("run_id")
    resolved_name = render_result.get("diagram_name") or diagram_name
    tla_result: dict[str, Any] | None = None
    ts_result: dict[str, Any] | None = None
    project_result: dict[str, Any] | None = None
    pipeline_result: dict[str, Any] | None = None

    if include_tla:
        if run_id:
            tla_result = mermate_render_tla(run_id=run_id, diagram_name=resolved_name)
        else:
            tla_result = {
                "success": False,
                "skipped": True,
                "error": "missing_run_id",
                "details": "Render stage did not return a run_id, so TLA+ could not start.",
            }

    if include_ts:
        if run_id and (not include_tla or (tla_result and tla_result.get("success"))):
            ts_result = mermate_render_ts(run_id=run_id, diagram_name=resolved_name)
        else:
            ts_result = {
                "success": False,
                "skipped": True,
                "error": "tla_required",
                "details": "TypeScript generation requires a successful TLA+ stage.",
            }

    if include_project_state and resolved_name:
        project_result = mermate_get_project(resolved_name)
        pipeline_result = mermate_get_project_pipeline(resolved_name)

    requested_stage_success = [render_result.get("success", False)]
    for optional_result in (tla_result, ts_result):
        if optional_result and not optional_result.get("skipped"):
            requested_stage_success.append(optional_result.get("success", False))

    return {
        "success": all(requested_stage_success),
        "diagram_name": resolved_name,
        "run_id": run_id,
        "render": render_result,
        "tla": tla_result,
        "ts": ts_result,
        "project": project_result,
        "pipeline": pipeline_result,
    }


@mcp.tool(description="Inspect the colocated OpenClaw wrapper that drives NemoClaw, local Ollama, and the Mermate sidecar.")
def openclaw_status() -> dict[str, Any]:
    return _call_openclaw_json("GET", "/api/status", timeout_s=DEFAULT_OPENCLAW_TIMEOUT_S)


@mcp.tool(description="Send a prompt through the OpenClaw wrapper using either the managed route or local Ollama.")
def openclaw_chat(
    prompt: str,
    transport: Literal["openshell", "ollama"] = "openshell",
    model: str | None = None,
    system_prompt: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    return _call_openclaw_json(
        "POST",
        "/api/chat",
        body={"messages": messages, "transport": transport, "model": model},
        timeout_s=timeout_s or DEFAULT_OPENCLAW_TIMEOUT_S,
    )


@mcp.tool(description="Probe a currently allowlisted host from inside the NemoClaw sandbox through the OpenClaw wrapper.")
def openclaw_connectivity_probe(host: str, timeout_s: int | None = None) -> dict[str, Any]:
    return _call_openclaw_json(
        "POST",
        "/api/connectivity/probe",
        body={"host": host},
        timeout_s=timeout_s or DEFAULT_OPENCLAW_TIMEOUT_S,
    )


@mcp.tool(description="Inspect the architect profile and Mermate sidecar state as seen by the OpenClaw wrapper.")
def openclaw_architect_status(timeout_s: int | None = None) -> dict[str, Any]:
    return _call_openclaw_json(
        "GET",
        "/api/architect/status",
        timeout_s=timeout_s or DEFAULT_OPENCLAW_TIMEOUT_S,
    )


@mcp.tool(description="Run the staged OpenClaw application-builder protocol from idea to architecture, optional formal stages, and optional scaffold.")
def openclaw_application_protocol(
    source: str,
    diagram_name: str | None = None,
    input_mode: Literal["idea", "markdown", "mmd"] = "idea",
    include_tla: bool = True,
    include_ts: bool = True,
    scaffold: bool = False,
    repo_name: str | None = None,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_openclaw_json(
        "POST",
        "/api/architect/pipeline",
        body={
            "source": source,
            "diagramName": diagram_name,
            "inputMode": input_mode,
            "maxMode": True,
            "includeTla": include_tla or include_ts,
            "includeTs": include_ts,
            "scaffold": scaffold,
            "repoName": repo_name,
        },
        timeout_s=timeout_s or max(DEFAULT_OPENCLAW_TIMEOUT_S, DEFAULT_AGENT_TIMEOUT_S),
    )


@mcp.tool(description="Scaffold a clean repository from an existing OpenClaw/Mermate run bundle.")
def openclaw_builder_scaffold(
    run_id: str,
    repo_name: str,
    source_idea: str,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_openclaw_json(
        "POST",
        "/api/builder/scaffold",
        body={"runId": run_id, "repoName": repo_name, "sourceIdea": source_idea},
        timeout_s=timeout_s or DEFAULT_OPENCLAW_TIMEOUT_S,
    )


@mcp.tool(description="Return the currently available Mermate agent modes.")
def mermate_agent_modes() -> dict[str, Any]:
    return _call_json("GET", "/api/agent/modes")


@mcp.tool(description="Run the Mermate agent preview workflow over SSE and return the summarized result.")
def mermate_agent_run(
    prompt: str,
    mode: str = "thinking",
    current_text: str | None = None,
    diagram_name: str | None = None,
    include_events: bool = False,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_sse(
        "/api/agent/run",
        body={
            "prompt": prompt,
            "mode": mode,
            "current_text": current_text,
            "diagram_name": diagram_name,
        },
        timeout_s=timeout_s or DEFAULT_AGENT_TIMEOUT_S,
        include_events=include_events,
    )


@mcp.tool(description="Run the Mermate agent finalize workflow over SSE and return the summarized result.")
def mermate_agent_finalize(
    current_text: str,
    mode: str = "thinking",
    user_notes: str | None = None,
    diagram_name: str | None = None,
    agent_parent_run_id: str | None = None,
    include_events: bool = False,
    timeout_s: int | None = None,
) -> dict[str, Any]:
    return _call_sse(
        "/api/agent/finalize",
        body={
            "current_text": current_text,
            "mode": mode,
            "user_notes": user_notes,
            "diagram_name": diagram_name,
            "agent_parent_run_id": agent_parent_run_id,
        },
        timeout_s=timeout_s or DEFAULT_AGENT_TIMEOUT_S,
        include_events=include_events,
    )


@mcp.tool(description="Run the two-stage agent workflow end to end: preview run first, then optional finalization.")
def mermate_agent_workflow(
    prompt: str,
    mode: str = "thinking",
    current_text: str | None = None,
    diagram_name: str | None = None,
    user_notes: str | None = None,
    finalize: bool = True,
    include_events: bool = False,
) -> dict[str, Any]:
    run_result = mermate_agent_run(
        prompt=prompt,
        mode=mode,
        current_text=current_text,
        diagram_name=diagram_name,
        include_events=include_events,
    )

    finalize_result: dict[str, Any] | None = None
    preview = run_result.get("preview_ready") or {}

    if finalize:
        draft_text = preview.get("draft_text") or current_text or prompt
        finalize_result = mermate_agent_finalize(
            current_text=draft_text,
            mode=mode,
            user_notes=user_notes,
            diagram_name=preview.get("diagram_name") or diagram_name,
            agent_parent_run_id=preview.get("run_id"),
            include_events=include_events,
        )

    success = run_result.get("success", False) and (
        not finalize or (finalize_result and finalize_result.get("success", False))
    )
    return {
        "success": success,
        "run": run_result,
        "finalize": finalize_result,
    }


@mcp.tool(description="List compiled diagrams currently available under Mermate flows.")
def mermate_list_diagrams() -> dict[str, Any]:
    return _call_json("GET", "/api/diagrams")


@mcp.tool(description="Rename an existing diagram and its associated artifacts.")
def mermate_rename_diagram(name: str, new_name: str) -> dict[str, Any]:
    return _call_json("PATCH", f"/api/diagrams/{name}", body={"new_name": new_name})


@mcp.tool(description="Delete a diagram bundle and its archived sources.")
def mermate_delete_diagram(name: str) -> dict[str, Any]:
    return _call_json("DELETE", f"/api/diagrams/{name}")


@mcp.tool(description="Upload a local audio file to Mermate's speech-to-text route.")
def mermate_transcribe(audio_path: str, timeout_s: int | None = None) -> dict[str, Any]:
    file_path = Path(audio_path).expanduser()
    if not file_path.is_file():
        return {
            "success": False,
            "error": "missing_audio_file",
            "details": f"Audio file not found: {file_path}",
        }

    client = create_client()
    try:
        return client.request_multipart_json(
            "/api/transcribe",
            file_field="audio",
            file_name=file_path.name,
            file_bytes=file_path.read_bytes(),
            content_type=client.guess_mime_type(file_path.name),
            timeout_s=timeout_s or DEFAULT_ROUTE_TIMEOUT_S,
        )
    except Exception as exc:
        return _normalize_api_error(exc, "/api/transcribe")


@mcp.tool(description="List indexed projects from the Mermate backend.")
def mermate_list_projects(
    limit: int = 50,
    offset: int = 0,
    sort: str = "updated_at",
) -> dict[str, Any]:
    return _call_json("GET", "/api/projects", query={"limit": limit, "offset": offset, "sort": sort})


@mcp.tool(description="Fetch one persisted project bundle by id or diagram name.")
def mermate_get_project(project_id: str) -> dict[str, Any]:
    return _call_json("GET", f"/api/projects/{project_id}")


@mcp.tool(description="Fetch project history for a persisted project.")
def mermate_get_project_history(project_id: str) -> dict[str, Any]:
    return _call_json("GET", f"/api/projects/{project_id}/history")


@mcp.tool(description="Run integrity verification for a persisted project bundle.")
def mermate_verify_project(project_id: str) -> dict[str, Any]:
    return _call_json("GET", f"/api/projects/{project_id}/verify")


@mcp.tool(description="Fetch pipeline progression and GoT metrics for a persisted project.")
def mermate_get_project_pipeline(project_id: str) -> dict[str, Any]:
    return _call_json("GET", f"/api/projects/{project_id}/pipeline")


@mcp.tool(description="Search the Mermate backend for similar runs and artifacts.")
def mermate_search(
    q: str,
    limit: int = 10,
    project: str | None = None,
    result_type: str | None = None,
) -> dict[str, Any]:
    return _call_json(
        "GET",
        "/api/search",
        query={"q": q, "limit": limit, "project": project, "type": result_type},
    )


@mcp.tool(description="Read the GoT scoreboard from the Mermate backend.")
def mermate_scoreboard(limit: int = 20) -> dict[str, Any]:
    return _call_json("GET", "/api/scoreboard", query={"limit": limit})


@mcp.tool(description="Call the Python meta-cognition refine endpoint through Mermate.")
def mermate_meta_refine(
    stage: str,
    message: str,
    seed_prompt: str | None = None,
) -> dict[str, Any]:
    return _call_json(
        "POST",
        "/api/meta/refine",
        body={"stage": stage, "msg": message, "seed_prompt": seed_prompt or ""},
    )


@mcp.tool(description="Audit a Mermate run through the Python meta-cognition layer.")
def mermate_meta_audit(run_id: str) -> dict[str, Any]:
    return _call_json("POST", "/api/meta/audit", body={"run_id": run_id})


@mcp.tool(description="Trigger one meta-cognition optimization cron cycle.")
def mermate_meta_cron() -> dict[str, Any]:
    return _call_json("POST", "/api/meta/cron")


@mcp.tool(description="List the loaded agent definitions from Mermate.")
def mermate_agents() -> dict[str, Any]:
    return _call_json("GET", "/api/agents")


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
