from __future__ import annotations

import json
import mimetypes
import os
from typing import Any
from urllib import error, parse, request
from uuid import uuid4


DEFAULT_BASE_URL = os.environ.get("MERMATE_URL", "http://127.0.0.1:3333").rstrip("/")
DEFAULT_TIMEOUT_S = float(os.environ.get("MERMATE_MCP_HTTP_TIMEOUT_S", "30"))
USER_AGENT = "mermate-openclaw-mcp/0.1.0"


class MermateHttpError(RuntimeError):
    def __init__(self, status: int, path: str, payload: Any) -> None:
        self.status = status
        self.path = path
        self.payload = payload
        super().__init__(self._format_message())

    def _format_message(self) -> str:
        if isinstance(self.payload, dict):
            detail = self.payload.get("details") or self.payload.get("error") or self.payload
            return f"{self.status} {self.path}: {detail}"
        return f"{self.status} {self.path}: {self.payload}"


class MermateClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout_s: float = DEFAULT_TIMEOUT_S) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> Any:
        response = self._open(
            method,
            path,
            body=body,
            query=query,
            timeout_s=timeout_s,
            headers={"Accept": "application/json"},
        )
        with response:
            return _read_json_payload(response.read())

    def request_multipart_json(
        self,
        path: str,
        *,
        file_field: str,
        file_name: str,
        file_bytes: bytes,
        fields: dict[str, str] | None = None,
        content_type: str | None = None,
        timeout_s: float | None = None,
    ) -> Any:
        boundary = f"----mermate-{uuid4().hex}"
        parts: list[bytes] = []

        for key, value in (fields or {}).items():
            parts.extend(
                [
                    f"--{boundary}\r\n".encode("utf-8"),
                    f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"),
                    value.encode("utf-8"),
                    b"\r\n",
                ]
            )

        safe_type = content_type or "application/octet-stream"
        parts.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{file_field}"; filename="{file_name}"\r\n'.encode("utf-8"),
                f"Content-Type: {safe_type}\r\n\r\n".encode("utf-8"),
                file_bytes,
                b"\r\n",
                f"--{boundary}--\r\n".encode("utf-8"),
            ]
        )

        req = request.Request(
            self._build_url(path),
            method="POST",
            data=b"".join(parts),
            headers={
                "Accept": "application/json",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": USER_AGENT,
            },
        )

        try:
            with request.urlopen(req, timeout=timeout_s or self.timeout_s) as response:
                return _read_json_payload(response.read())
        except error.HTTPError as exc:
            payload = _read_json_payload(exc.read())
            raise MermateHttpError(exc.code, path, payload) from exc
        except error.URLError as exc:
            raise RuntimeError(f"Failed to reach {self._build_url(path)}: {exc.reason}") from exc

    def stream_sse(
        self,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> list[dict[str, Any]]:
        response = self._open(
            "POST",
            path,
            body=body,
            timeout_s=timeout_s,
            headers={"Accept": "text/event-stream"},
        )

        events: list[dict[str, Any]] = []
        event_type: str | None = None
        data_lines: list[str] = []

        def flush_event() -> None:
            nonlocal event_type, data_lines
            if not data_lines:
                event_type = None
                return

            raw_data = "\n".join(data_lines)
            try:
                parsed = json.loads(raw_data)
                if not isinstance(parsed, dict):
                    parsed = {"type": event_type or "message", "data": parsed}
            except json.JSONDecodeError:
                parsed = {"type": event_type or "message", "data": raw_data}

            if event_type and "type" not in parsed:
                parsed["type"] = event_type

            events.append(parsed)
            event_type = None
            data_lines = []

        with response:
            for raw_line in response:
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if not line:
                    flush_event()
                    continue
                if line.startswith(":"):
                    continue

                field, _, value = line.partition(":")
                value = value.lstrip(" ")
                if field == "event":
                    event_type = value
                elif field == "data":
                    data_lines.append(value)

            flush_event()

        return events

    def guess_mime_type(self, file_name: str) -> str:
        return mimetypes.guess_type(file_name)[0] or "application/octet-stream"

    def _open(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        timeout_s: float | None = None,
        headers: dict[str, str] | None = None,
    ):
        data = None
        request_headers = {
            "User-Agent": USER_AGENT,
            **(headers or {}),
        }

        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"

        req = request.Request(
            self._build_url(path, query=query),
            method=method.upper(),
            data=data,
            headers=request_headers,
        )

        try:
            return request.urlopen(req, timeout=timeout_s or self.timeout_s)
        except error.HTTPError as exc:
            payload = _read_json_payload(exc.read())
            raise MermateHttpError(exc.code, path, payload) from exc
        except error.URLError as exc:
            raise RuntimeError(f"Failed to reach {self._build_url(path)}: {exc.reason}") from exc

    def _build_url(self, path: str, query: dict[str, Any] | None = None) -> str:
        clean_path = path if path.startswith("/") else f"/{path}"
        url = f"{self.base_url}{clean_path}"
        if not query:
            return url

        encoded = parse.urlencode(
            {
                key: value
                for key, value in query.items()
                if value is not None
            }
        )
        return f"{url}?{encoded}" if encoded else url


def summarize_sse_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    stages = [event.get("stage") for event in events if event.get("type") == "stage" and event.get("stage")]
    errors = [event for event in events if event.get("type") == "error"]
    preview_ready = _last_event_of_type(events, "preview_ready")
    final_render = _last_event_of_type(events, "final_render")
    done = _last_event_of_type(events, "done")
    return {
        "event_count": len(events),
        "stages": stages,
        "errors": errors,
        "preview_ready": preview_ready,
        "final_render": final_render,
        "done": done,
        "last_event_type": events[-1].get("type") if events else None,
    }


def _last_event_of_type(events: list[dict[str, Any]], event_type: str) -> dict[str, Any] | None:
    for event in reversed(events):
        if event.get("type") == event_type:
            return event
    return None


def _read_json_payload(raw: bytes) -> Any:
    text = raw.decode("utf-8").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}

