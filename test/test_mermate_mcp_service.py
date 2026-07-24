from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp_service.client import MermateClient, MermateHttpError, summarize_sse_events, get_shared_client, get_shared_openclaw_client
from mcp_service.server import (
    STAGE_MAP,
    TOOL_ROUTE_MAP,
    mermate_status,
    mermate_agent_active,
    mermate_agent_stop,
    mermate_list_runs,
    mermate_get_run,
    mermate_get_run_summary,
    mermate_get_run_trace,
    mermate_get_artifacts,
    mermate_get_bundle,
    mermate_rate_master_metrics,
    mermate_render_rust,
    mermate_render_tsx,
    mermate_render_ts_source,
    mermate_specula_health,
    mermate_specula_validate_tlc,
    mermate_specula_skill,
    mermate_guide_status,
    mermate_guide_evaluate,
    mermate_trace_append,
    mermate_trace_get,
    mermate_trace_stats,
    tla_harness_info,
    tla_harness_sany,
    tla_harness_tlc,
    tla_harness_pluscal,
    tla_harness_latex,
    mcp_context_get,
    mcp_context_clear,
    mcp_context_remember,
    mcp_context_recall,
    mcp_runtime_log,
    mcp_runtime_stats,
    mcp_runtime_log_clear,
    mcp_controller_observe,
    mcp_session_set,
    mcp_session_get,
    mcp_session_list,
    mcp_session_clear,
    mcp_preview_get,
    mcp_preview_all,
    mcp_preview_clear,
)
from mcp_service.tla_harness import is_available as harness_is_available, JAR_PATH
from mcp_service.runtime_logger import log_event, get_recent, get_stats, clear as log_clear
from mcp_service.context_memory import remember, recall, snapshot, clear as ctx_clear, clear_all as ctx_clear_all, observe, get_context_summary, set_session, get_session, list_sessions, clear_session, get_preview, get_all_previews, clear_previews


class StubHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/json"):
            self._send_json(200, {"success": True, "hello": "world"})
            return

        if self.path.startswith("/error"):
            self._send_json(422, {"success": False, "error": "bad_request", "details": "broken"})
            return

        self._send_json(404, {"success": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/sse"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in (
                {"type": "stage", "stage": "planning"},
                {"type": "preview_ready", "draft_text": "draft", "diagram_name": "demo"},
                {"type": "done", "final_text": "final"},
            ):
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
            return

        if self.path.startswith("/multipart"):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            content_type = self.headers.get("Content-Type", "")
            ok = "multipart/form-data" in content_type and b'name="audio"' in body
            self._send_json(200, {"success": ok, "received": ok})
            return

        self._send_json(404, {"success": False, "error": "not_found"})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class MermateClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.httpd.server_address
        cls.client = MermateClient(base_url=f"http://{host}:{port}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.thread.join(timeout=2)

    def test_request_json_returns_payload(self) -> None:
        payload = self.client.request_json("GET", "/json")
        self.assertTrue(payload["success"])
        self.assertEqual(payload["hello"], "world")

    def test_request_json_raises_structured_http_error(self) -> None:
        with self.assertRaises(MermateHttpError) as ctx:
            self.client.request_json("GET", "/error")

        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.payload["error"], "bad_request")

    def test_stream_sse_collects_events_and_summary(self) -> None:
        events = self.client.stream_sse("/sse", body={"prompt": "hi"})
        summary = summarize_sse_events(events)

        self.assertEqual(len(events), 3)
        self.assertEqual(summary["stages"], ["planning"])
        self.assertEqual(summary["preview_ready"]["diagram_name"], "demo")
        self.assertEqual(summary["done"]["final_text"], "final")

    def test_request_multipart_json_uploads_audio_field(self) -> None:
        payload = self.client.request_multipart_json(
            "/multipart",
            file_field="audio",
            file_name="sample.wav",
            file_bytes=b"RIFF",
            content_type="audio/wav",
        )
        self.assertTrue(payload["success"])


class SharedClientTests(unittest.TestCase):
    def test_get_shared_client_returns_singleton(self) -> None:
        c1 = get_shared_client()
        c2 = get_shared_client()
        self.assertIs(c1, c2)

    def test_get_shared_openclaw_client_returns_singleton(self) -> None:
        c1 = get_shared_openclaw_client("http://127.0.0.1:8787", 120.0)
        c2 = get_shared_openclaw_client("http://127.0.0.1:8787", 120.0)
        self.assertIs(c1, c2)


class StubApiHandler(BaseHTTPRequestHandler):
    """Stub handler that simulates the Mermate Express API for all new MCP tools."""

    def do_GET(self) -> None:  # noqa: N802
        self._send_json(200, {"success": True, "path": self.path})

    def do_POST(self) -> None:  # noqa: N802
        self._send_json(200, {"success": True, "path": self.path})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class McpServerToolsTests(unittest.TestCase):
    """Verify that all newly added MCP tools can be imported and called without syntax/runtime errors."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), StubApiHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.httpd.server_address
        cls.base_url = f"http://{host}:{port}"
        import mcp_service.client as client_mod
        client_mod._shared_client = MermateClient(base_url=cls.base_url, timeout_s=5.0)
        import mcp_service.server as server_mod
        server_mod.DEFAULT_BASE_URL = cls.base_url

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.thread.join(timeout=2)

    def test_status_returns_all_keys(self) -> None:
        result = mermate_status()
        self.assertIn("base_url", result)
        for key in ("copilot", "tla", "ts", "rust", "tsx", "agent_modes", "meta", "rate_master", "specula", "guide"):
            self.assertIn(key, result)

    def test_agent_active_callable(self) -> None:
        result = mermate_agent_active()
        self.assertIn("success", result)

    def test_agent_stop_callable(self) -> None:
        result = mermate_agent_stop("test-session-id")
        self.assertIn("success", result)

    def test_list_runs_callable(self) -> None:
        result = mermate_list_runs(limit=5)
        self.assertIn("success", result)

    def test_get_run_callable(self) -> None:
        result = mermate_get_run("test-run-id")
        self.assertIn("success", result)

    def test_get_run_summary_callable(self) -> None:
        result = mermate_get_run_summary("test-run-id")
        self.assertIn("success", result)

    def test_get_run_trace_callable(self) -> None:
        result = mermate_get_run_trace("test-run-id")
        self.assertIn("success", result)

    def test_get_artifacts_callable(self) -> None:
        result = mermate_get_artifacts("test-run-id")
        self.assertIn("success", result)

    def test_get_bundle_callable(self) -> None:
        result = mermate_get_bundle("test-run-id")
        self.assertIn("success", result)

    def test_rate_master_metrics_callable(self) -> None:
        result = mermate_rate_master_metrics()
        self.assertIn("success", result)

    def test_render_rust_callable(self) -> None:
        result = mermate_render_rust("test-run-id")
        self.assertIn("success", result)

    def test_render_tsx_callable(self) -> None:
        result = mermate_render_tsx("test-run-id")
        self.assertIn("success", result)

    def test_render_ts_source_callable(self) -> None:
        result = mermate_render_ts_source("test-run-id")
        self.assertIn("success", result)

    def test_specula_health_callable(self) -> None:
        result = mermate_specula_health()
        self.assertIn("success", result)

    def test_specula_validate_tlc_callable(self) -> None:
        result = mermate_specula_validate_tlc("/tmp/spec.tla", "/tmp/spec.cfg")
        self.assertIn("success", result)

    def test_specula_skill_callable(self) -> None:
        result = mermate_specula_skill("my-skill", "SKILL.md")
        self.assertIn("success", result)

    def test_guide_status_callable(self) -> None:
        result = mermate_guide_status()
        self.assertIn("success", result)

    def test_guide_evaluate_callable(self) -> None:
        result = mermate_guide_evaluate({"tab": "mmd"})
        self.assertIn("success", result)

    def test_trace_append_callable(self) -> None:
        result = mermate_trace_append("test-run-id", {"event": "stage_complete"})
        self.assertIn("success", result)

    def test_trace_get_callable(self) -> None:
        result = mermate_trace_get("test-run-id")
        self.assertIn("success", result)

    def test_trace_stats_callable(self) -> None:
        result = mermate_trace_stats()
        self.assertIn("success", result)


class StageMapTests(unittest.TestCase):
    def test_stage_map_includes_new_stages(self) -> None:
        for key in ("render", "tla", "ts", "rust", "tsx", "agent_preview", "agent_finalize", "agent_session", "runs", "artifacts", "bundle", "guide", "specula", "trace"):
            self.assertIn(key, STAGE_MAP, f"STAGE_MAP missing key: {key}")

    def test_tool_route_map_includes_new_tools(self) -> None:
        for key in ("mermate_status", "mermate_render_rust", "mermate_render_tsx", "mermate_render_ts_source", "mermate_agent_active", "mermate_agent_attach", "mermate_agent_stop", "mermate_list_runs", "mermate_get_run", "mermate_get_run_summary", "mermate_get_run_trace", "mermate_get_artifacts", "mermate_get_bundle", "mermate_rate_master_metrics", "mermate_specula_health", "mermate_specula_validate_tlc", "mermate_specula_skill", "mermate_guide_status", "mermate_guide_evaluate", "mermate_trace_append", "mermate_trace_get", "mermate_trace_stats", "tla_harness_info", "tla_harness_sany", "tla_harness_tlc", "tla_harness_pluscal", "tla_harness_latex", "mcp_context_get", "mcp_context_clear", "mcp_context_remember", "mcp_context_recall", "mcp_runtime_log", "mcp_runtime_stats", "mcp_runtime_log_clear", "mcp_controller_observe", "mcp_session_set", "mcp_session_get", "mcp_session_list", "mcp_session_clear", "mcp_preview_get", "mcp_preview_all", "mcp_preview_clear"):
            self.assertIn(key, TOOL_ROUTE_MAP, f"TOOL_ROUTE_MAP missing key: {key}")

    def test_stage_map_includes_mcp_controller(self) -> None:
        self.assertIn("mcp_controller", STAGE_MAP)
        self.assertIn("tla_harness", STAGE_MAP)


class TlaHarnessTests(unittest.TestCase):
    """Verify the TLA+ harness can locate the jar and run tools."""

    def test_jar_exists(self) -> None:
        self.assertTrue(JAR_PATH.exists(), f"tla2tools.jar not found at {JAR_PATH}")

    def test_harness_info_returns_structure(self) -> None:
        info = tla_harness_info()
        self.assertIn("available", info)
        self.assertIn("jar_path", info)
        self.assertIn("tools", info)
        for tool in ("sany", "tlc", "pluscal", "latex"):
            self.assertIn(tool, info["tools"])

    def test_sany_valid_spec(self) -> None:
        if not harness_is_available():
            self.skipTest("Java or tla2tools.jar not available")
        result = tla_harness_sany(
            "---- MODULE TestSpec ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x' = x + 1\nSpec == Init /\\ [][Next]_x\n=============\n",
            module_name="TestSpec",
        )
        self.assertTrue(result["valid"], f"SANY should accept valid spec: {result.get('errors')}")

    def test_sany_invalid_spec(self) -> None:
        if not harness_is_available():
            self.skipTest("Java or tla2tools.jar not available")
        result = tla_harness_sany(
            "---- MODULE BadSpec ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == y' = x + 1\n=============\n",
            module_name="BadSpec",
        )
        self.assertFalse(result["valid"])
        self.assertTrue(len(result["errors"]) > 0)

    def test_tlc_valid_spec(self) -> None:
        if not harness_is_available():
            self.skipTest("Java or tla2tools.jar not available")
        result = tla_harness_tlc(
            "---- MODULE Counter ----\nEXTENDS Naturals\nCONSTANTS Max\nVARIABLES x\nInit == x = 0\nNext == x < Max /\\ x' = x + 1\nSpec == Init /\\ [][Next]_x\nTypeInvariant == x \\in 0..Max\n=============\n",
            cfg_source="SPECIFICATION Spec\nINVARIANT TypeInvariant\nCHECK_DEADLOCK FALSE\nCONSTANTS\nMax = 5\n",
            module_name="Counter",
        )
        self.assertTrue(result["checked"])
        self.assertTrue(result["success"], f"TLC should pass valid spec: {result.get('violations')}")

    def test_pluscal_callable(self) -> None:
        if not harness_is_available():
            self.skipTest("Java or tla2tools.jar not available")
        result = tla_harness_pluscal(
            "---- MODULE PcalTest ----\n(* --algorithm TestAlgo\nbegin\n  skip;\nend algorithm; *)\n=============\n",
            module_name="PcalTest",
        )
        self.assertIn("ok", result)

    def test_latex_callable(self) -> None:
        if not harness_is_available():
            self.skipTest("Java or tla2tools.jar not available")
        result = tla_harness_latex(
            "---- MODULE TexTest ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x' = x + 1\nSpec == Init /\\ [][Next]_x\n=============\n",
            module_name="TexTest",
        )
        self.assertIn("ok", result)


class RuntimeLoggerTests(unittest.TestCase):
    """Verify the NDJSON runtime logger writes and reads structured events."""

    def setUp(self) -> None:
        log_clear()

    def tearDown(self) -> None:
        log_clear()

    def test_log_and_retrieve(self) -> None:
        log_event("test_tool", "mermate", method="GET", path="/api/test", status="ok", duration_ms=42.5)
        entries = get_recent(limit=10)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["tool"], "test_tool")
        self.assertEqual(entries[0]["gateway"], "mermate")
        self.assertEqual(entries[0]["status"], "ok")

    def test_filter_by_tool(self) -> None:
        log_event("tool_a", "mermate", status="ok")
        log_event("tool_b", "harness", status="ok")
        entries = get_recent(limit=10, tool="tool_a")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["tool"], "tool_a")

    def test_filter_by_gateway(self) -> None:
        log_event("tool_a", "mermate", status="ok")
        log_event("tool_b", "harness", status="ok")
        entries = get_recent(limit=10, gateway="harness")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["gateway"], "harness")

    def test_filter_by_status(self) -> None:
        log_event("tool_a", "mermate", status="ok")
        log_event("tool_b", "mermate", status="error")
        errors = get_recent(limit=10, status="error")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["status"], "error")

    def test_stats_aggregation(self) -> None:
        log_event("tool_a", "mermate", status="ok", duration_ms=100)
        log_event("tool_a", "mermate", status="ok", duration_ms=200)
        log_event("tool_b", "harness", status="error", duration_ms=50)
        stats = get_stats()
        self.assertEqual(stats["total_calls"], 3)
        self.assertEqual(stats["tools"]["tool_a"], 2)
        self.assertEqual(stats["tools"]["tool_b"], 1)
        self.assertEqual(stats["error_count"], 1)
        self.assertGreater(stats["avg_duration_ms"], 0)

    def test_truncation(self) -> None:
        big_args = {f"key_{i}": f"val_{i}" for i in range(20)}
        log_event("test_tool", "mermate", args=big_args, status="ok")
        entries = get_recent(limit=1)
        self.assertIn("_truncated", entries[0]["args_summary"])

    def test_clear(self) -> None:
        log_event("tool_a", "mermate", status="ok")
        removed = log_clear()
        self.assertGreaterEqual(removed, 1)
        self.assertEqual(get_recent(), [])


class ContextMemoryTests(unittest.TestCase):
    """Verify agent context memory auto-extraction and manual API."""

    def setUp(self) -> None:
        ctx_clear()

    def tearDown(self) -> None:
        ctx_clear()

    def test_remember_and_recall(self) -> None:
        remember("run_id", "abc-123")
        self.assertEqual(recall("run_id"), "abc-123")

    def test_recall_missing_returns_none(self) -> None:
        self.assertIsNone(recall("nonexistent"))

    def test_snapshot(self) -> None:
        remember("key1", "val1")
        remember("key2", "val2")
        snap = snapshot()
        self.assertEqual(snap["key1"], "val1")
        self.assertEqual(snap["key2"], "val2")

    def test_observe_extracts_run_id(self) -> None:
        observe("mermate_render", {"text": "test"}, {"success": True, "run_id": "xyz-789"}, gateway="mermate")
        snap = snapshot()
        self.assertEqual(snap["run_id"], "xyz-789")
        self.assertEqual(snap["last_tool"], "mermate_render")
        self.assertEqual(snap["ok_calls"], 1)

    def test_observe_extracts_from_args(self) -> None:
        observe("mermate_render_tla", {"run_id": "abc-123"}, {"success": True}, gateway="mermate")
        snap = snapshot()
        self.assertEqual(snap["run_id"], "abc-123")

    def test_observe_tracks_errors(self) -> None:
        observe("mermate_render", {}, {"success": False}, gateway="mermate")
        snap = snapshot()
        self.assertEqual(snap["err_calls"], 1)
        self.assertEqual(snap.get("ok_calls", 0), 0)

    def test_clear(self) -> None:
        remember("key1", "val1")
        ctx_clear()
        self.assertIsNone(recall("key1"))

    def test_context_summary(self) -> None:
        observe("tool_a", {}, {"success": True, "run_id": "r1"}, gateway="mermate")
        summary = get_context_summary()
        self.assertIn("context", summary)
        self.assertIn("recent_history", summary)
        self.assertEqual(summary["context"]["run_id"], "r1")


class McpControllerTests(unittest.TestCase):
    """Verify MCP controller observer and context tools are callable."""

    def setUp(self) -> None:
        ctx_clear()
        log_clear()

    def tearDown(self) -> None:
        ctx_clear()
        log_clear()

    def test_context_get_returns_summary(self) -> None:
        result = mcp_context_get()
        self.assertIn("context", result)
        self.assertIn("recent_history", result)

    def test_context_clear(self) -> None:
        result = mcp_context_clear()
        self.assertTrue(result["success"])

    def test_context_remember_and_recall(self) -> None:
        mcp_context_remember("test_key", "test_value")
        result = mcp_context_recall("test_key")
        self.assertTrue(result["found"])
        self.assertEqual(result["value"], "test_value")

    def test_runtime_log_returns_entries(self) -> None:
        log_event("test_tool", "mermate", status="ok")
        result = mcp_runtime_log(limit=10)
        self.assertIn("count", result)
        self.assertIn("entries", result)
        self.assertGreaterEqual(result["count"], 1)

    def test_runtime_stats_returns_structure(self) -> None:
        result = mcp_runtime_stats()
        self.assertIn("total_calls", result)
        self.assertIn("tools", result)

    def test_runtime_log_clear(self) -> None:
        result = mcp_runtime_log_clear()
        self.assertTrue(result["success"])

    def test_controller_observe_returns_full_snapshot(self) -> None:
        result = mcp_controller_observe(log_limit=5)
        self.assertIn("context", result)
        self.assertIn("recent_log", result)
        self.assertIn("stats", result)
        self.assertIn("stage_map", result)
        self.assertIn("tool_route_map", result)
        self.assertIn("server", result)
        self.assertEqual(result["server"]["name"], "mermate-openclaw-mcp")


class SessionManagementTests(unittest.TestCase):
    """Verify per-session context isolation and session lifecycle."""

    def setUp(self) -> None:
        ctx_clear_all()

    def tearDown(self) -> None:
        ctx_clear_all()

    def test_set_session_creates_new(self) -> None:
        sid = set_session()
        self.assertIsNotNone(sid)
        self.assertEqual(get_session(), sid)

    def test_set_session_switches_existing(self) -> None:
        sid1 = set_session()
        remember("key1", "val1")
        sid2 = set_session()
        remember("key2", "val2")
        set_session(sid1)
        self.assertEqual(recall("key1"), "val1")
        self.assertIsNone(recall("key2"))
        set_session(sid2)
        self.assertEqual(recall("key2"), "val2")
        self.assertIsNone(recall("key1"))

    def test_list_sessions(self) -> None:
        sid1 = set_session()
        sid2 = set_session()
        sessions = list_sessions()
        self.assertEqual(len(sessions), 2)
        active = [s for s in sessions if s["active"]]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["session_id"], sid2)

    def test_clear_session(self) -> None:
        sid1 = set_session()
        sid2 = set_session()
        clear_session(sid1)
        sessions = list_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["session_id"], sid2)

    def test_clear_active_session(self) -> None:
        sid = set_session()
        remember("key", "val")
        clear_session()
        self.assertIsNone(get_session())

    def test_mcp_session_set_and_get(self) -> None:
        result = mcp_session_set()
        self.assertTrue(result["success"])
        sid = result["session_id"]
        result2 = mcp_session_get()
        self.assertEqual(result2["session_id"], sid)

    def test_mcp_session_list(self) -> None:
        mcp_session_set()
        result = mcp_session_list()
        self.assertIn("sessions", result)
        self.assertGreaterEqual(len(result["sessions"]), 1)

    def test_mcp_session_clear(self) -> None:
        mcp_session_set()
        result = mcp_session_clear()
        self.assertTrue(result["success"])


class StagePreviewTests(unittest.TestCase):
    """Verify stage preview capture from tool results."""

    def setUp(self) -> None:
        ctx_clear_all()

    def tearDown(self) -> None:
        ctx_clear_all()

    def test_observe_captures_render_preview(self) -> None:
        observe("mermate_render", {"text": "my idea"}, {
            "success": True,
            "run_id": "r1",
            "compiled_source": "graph TD\n  A-->B",
            "markdown_source": "# My Diagram",
        }, gateway="mermate")
        preview = get_preview("render")
        self.assertIsNotNone(preview)
        self.assertIn("compiled_source", preview)
        self.assertIn("markdown_source", preview)
        self.assertEqual(preview["compiled_source"], "graph TD\n  A-->B")

    def test_observe_captures_tla_preview(self) -> None:
        observe("mermate_render_tla", {"run_id": "r1"}, {
            "success": True,
            "tla_source": "---- MODULE Spec ----",
            "cfg_source": "SPECIFICATION Spec",
        }, gateway="mermate")
        preview = get_preview("tla")
        self.assertIsNotNone(preview)
        self.assertIn("tla_source", preview)
        self.assertEqual(preview["tla_source"], "---- MODULE Spec ----")

    def test_observe_captures_ts_preview(self) -> None:
        observe("mermate_render_ts", {"run_id": "r1"}, {
            "success": True,
            "ts_source": "export class Foo {}",
            "harness_source": "describe('Foo', () => {})",
        }, gateway="mermate")
        preview = get_preview("ts")
        self.assertIsNotNone(preview)
        self.assertIn("ts_source", preview)

    def test_observe_captures_rust_preview(self) -> None:
        observe("mermate_render_rust", {"run_id": "r1"}, {
            "success": True,
            "rust_source": "fn main() {}",
        }, gateway="mermate")
        preview = get_preview("rust")
        self.assertIsNotNone(preview)
        self.assertIn("rust_source", preview)

    def test_observe_captures_harness_sany_preview(self) -> None:
        observe("tla_harness_sany", {"tla_source": "test"}, {
            "valid": True,
            "stdout": "Parsing module...",
        }, gateway="harness")
        preview = get_preview("tla")
        # SANY doesn't return tla_source, so no preview fields captured
        # But the stage should still be tracked
        self.assertIsNone(preview)

    def test_get_all_previews(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        observe("mermate_render_tla", {"run_id": "r1"}, {"success": True, "tla_source": "tla"}, gateway="mermate")
        all_previews = get_all_previews()
        self.assertIn("render", all_previews)
        self.assertIn("tla", all_previews)

    def test_clear_previews(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        clear_previews()
        self.assertEqual(get_all_previews(), {})

    def test_previews_isolated_per_session(self) -> None:
        sid1 = set_session()
        observe("mermate_render", {}, {"success": True, "compiled_source": "session1"}, gateway="mermate")
        sid2 = set_session()
        observe("mermate_render", {}, {"success": True, "compiled_source": "session2"}, gateway="mermate")
        set_session(sid1)
        self.assertEqual(get_preview("render")["compiled_source"], "session1")
        set_session(sid2)
        self.assertEqual(get_preview("render")["compiled_source"], "session2")

    def test_context_summary_includes_previews(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        summary = get_context_summary()
        self.assertIn("previews", summary)
        self.assertIn("render", summary["previews"])
        self.assertIn("preview_stages", summary)
        self.assertIn("render", summary["preview_stages"])

    def test_mcp_preview_get(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        result = mcp_preview_get("render")
        self.assertTrue(result["success"])
        self.assertEqual(result["stage"], "render")
        self.assertIn("compiled_source", result["preview"])

    def test_mcp_preview_get_missing(self) -> None:
        result = mcp_preview_get("nonexistent")
        self.assertFalse(result["success"])

    def test_mcp_preview_all(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        result = mcp_preview_all()
        self.assertTrue(result["success"])
        self.assertIn("render", result["previews"])

    def test_mcp_preview_clear(self) -> None:
        observe("mermate_render", {}, {"success": True, "compiled_source": "mmd"}, gateway="mermate")
        result = mcp_preview_clear()
        self.assertTrue(result["success"])


if __name__ == "__main__":
    unittest.main()
