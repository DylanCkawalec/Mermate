from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp_service.client import MermateClient, MermateHttpError, summarize_sse_events


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


if __name__ == "__main__":
    unittest.main()
