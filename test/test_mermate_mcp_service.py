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
)
from mcp_service.tla_harness import is_available as harness_is_available, JAR_PATH


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
        for key in ("mermate_status", "mermate_render_rust", "mermate_render_tsx", "mermate_render_ts_source", "mermate_agent_active", "mermate_agent_attach", "mermate_agent_stop", "mermate_list_runs", "mermate_get_run", "mermate_get_run_summary", "mermate_get_run_trace", "mermate_get_artifacts", "mermate_get_bundle", "mermate_rate_master_metrics", "mermate_specula_health", "mermate_specula_validate_tlc", "mermate_specula_skill", "mermate_guide_status", "mermate_guide_evaluate", "mermate_trace_append", "mermate_trace_get", "mermate_trace_stats", "tla_harness_info", "tla_harness_sany", "tla_harness_tlc", "tla_harness_pluscal", "tla_harness_latex"):
            self.assertIn(key, TOOL_ROUTE_MAP, f"TOOL_ROUTE_MAP missing key: {key}")


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


if __name__ == "__main__":
    unittest.main()
