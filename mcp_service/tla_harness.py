"""Direct TLA+ tools harness — wraps tla2tools.jar via subprocess.

Exposes SANY (syntax check), TLC (model checker), PlusCal (algorithm compiler),
and TLA2TeX (LaTeX pretty-printer) as callable Python functions.

This is the direct MCP→jar path, cutting out the Express API middleman.
The AI can use these as a general-purpose TLA+ toolbox.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
JAR_PATH = PROJECT_ROOT / "vendor" / "tla2tools.jar"

SANY_TIMEOUT_S = float(os.environ.get("MERMATE_HARNESS_SANY_TIMEOUT_S", "30"))
TLC_TIMEOUT_S = float(os.environ.get("MERMATE_HARNESS_TLC_TIMEOUT_S", "120"))
PCAL_TIMEOUT_S = float(os.environ.get("MERMATE_HARNESS_PCAL_TIMEOUT_S", "30"))
TEX_TIMEOUT_S = float(os.environ.get("MERMATE_HARNESS_TEX_TIMEOUT_S", "30"))

_java_checked: bool | None = None
_java_version: str | None = None


def _check_java() -> bool:
    global _java_checked, _java_version
    if _java_checked is not None:
        return _java_checked
    try:
        r = subprocess.run(
            ["java", "-version"],
            capture_output=True, text=True, timeout=10,
        )
        _java_checked = r.returncode == 0
        if _java_checked:
            line = (r.stderr or r.stdout or "").split("\n")[0]
            m = re.search(r'"([^"]+)"', line)
            _java_version = m.group(1) if m else "unknown"
    except Exception:
        _java_checked = False
    return _java_checked


def _jar_exists() -> bool:
    return JAR_PATH.exists()


def is_available() -> bool:
    return _check_java() and _jar_exists()


def get_info() -> dict[str, Any]:
    return {
        "available": is_available(),
        "java_version": _java_version,
        "jar_path": str(JAR_PATH),
        "jar_exists": _jar_exists(),
        "tools": {
            "sany": "tla2sany.SANY — syntax parser and semantic checker",
            "tlc": "tlc2.TLC — model checker with invariant checking",
            "pluscal": "pcal.trans — PlusCal algorithm to TLA+ compiler",
            "latex": "tla2tex.TLA — TLA+ to LaTeX pretty-printer",
        },
        "timeouts": {
            "sany_s": SANY_TIMEOUT_S,
            "tlc_s": TLC_TIMEOUT_S,
            "pluscal_s": PCAL_TIMEOUT_S,
            "tex_s": TEX_TIMEOUT_S,
        },
    }


def _run_java(class_name: str, args: list[str], timeout_s: float, cwd: str | None = None) -> dict[str, Any]:
    if not _check_java():
        return {"ok": False, "error": "Java not available", "stdout": "", "stderr": ""}
    if not _jar_exists():
        return {"ok": False, "error": f"JAR not found at {JAR_PATH}", "stdout": "", "stderr": ""}

    cmd = ["java", "-cp", str(JAR_PATH), class_name] + args
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s, cwd=cwd,
        )
        return {
            "ok": r.returncode == 0,
            "exit_code": r.returncode,
            "stdout": r.stdout,
            "stderr": r.stderr,
            "timed_out": False,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Timed out after {timeout_s}s", "stdout": "", "stderr": "", "timed_out": True}
    except Exception as e:
        return {"ok": False, "error": str(e), "stdout": "", "stderr": "", "timed_out": False}


def _parse_sany_output(stdout: str, stderr: str) -> list[str]:
    combined = (stdout + "\n" + stderr).split("\n")
    errors = []
    for line in combined:
        if re.search(r"error|abort|could not|unknown|unexpected|illegal", line, re.IGNORECASE):
            if not re.match(r"Parsing\s+file|Semantic\s+processing", line):
                errors.append(line.strip())
    return [e for e in errors if e]


def sany_check(tla_source: str, module_name: str = "Spec") -> dict[str, Any]:
    """Run SANY syntax check on TLA+ source. Returns structured parse results."""
    with tempfile.TemporaryDirectory(prefix="tla_harness_") as tmpdir:
        tla_path = Path(tmpdir) / f"{module_name}.tla"
        tla_path.write_text(tla_source, encoding="utf-8")
        r = _run_java("tla2sany.SANY", [str(tla_path)], SANY_TIMEOUT_S, cwd=tmpdir)
        errors = _parse_sany_output(r.get("stdout", ""), r.get("stderr", ""))
        return {
            "valid": r.get("ok", False) and len(errors) == 0,
            "errors": errors,
            "exit_code": r.get("exit_code"),
            "stdout": r.get("stdout", ""),
            "stderr": r.get("stderr", ""),
            "timed_out": r.get("timed_out", False),
            "module_name": module_name,
        }


def tlc_check(tla_source: str, cfg_source: str | None = None, module_name: str = "Spec") -> dict[str, Any]:
    """Run TLC model checker on TLA+ source with optional config. Returns structured results."""
    with tempfile.TemporaryDirectory(prefix="tla_harness_tlc_") as tmpdir:
        tla_path = Path(tmpdir) / f"{module_name}.tla"
        tla_path.write_text(tla_source, encoding="utf-8")

        cfg_path = None
        if cfg_source:
            cfg_path = Path(tmpdir) / f"{module_name}.cfg"
            cfg_path.write_text(cfg_source, encoding="utf-8")
        else:
            cfg_path = Path(tmpdir) / f"{module_name}.cfg"
            cfg_path.write_text("SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\n", encoding="utf-8")

        trace_path = Path(tmpdir) / "trace.json"
        args = [
            "-config", str(cfg_path),
            "-workers", "auto",
            "-deadlock",
            "-checkpoint", "0",
            "-cleanup",
            "-dumpTrace", "json", str(trace_path),
            str(tla_path),
        ]
        r = _run_java("tlc2.TLC", args, TLC_TIMEOUT_S, cwd=tmpdir)

        combined = (r.get("stdout", "") + "\n" + r.get("stderr", ""))
        violations = []
        for m in re.finditer(r"Invariant\s+(\w+)\s+is\s+violated", combined, re.IGNORECASE):
            violations.append({"type": "invariant_violation", "invariant": m.group(1)})
        if re.search(r"Deadlock\s+reached", combined, re.IGNORECASE):
            violations.append({"type": "deadlock", "invariant": "Deadlock"})
        for m in re.finditer(r"Property\s+(\w+)\s+is\s+violated", combined, re.IGNORECASE):
            violations.append({"type": "temporal_violation", "invariant": m.group(1)})

        states_match = re.search(r"(\d+)\s+states?\s+generated", combined, re.IGNORECASE)
        states_explored = int(states_match.group(1)) if states_match else 0

        trace = None
        if trace_path.exists():
            try:
                trace = json.loads(trace_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        return {
            "success": r.get("ok", False) and len(violations) == 0,
            "checked": not r.get("timed_out", False),
            "violations": violations,
            "states_explored": states_explored,
            "trace": trace,
            "exit_code": r.get("exit_code"),
            "stdout": r.get("stdout", ""),
            "stderr": r.get("stderr", ""),
            "timed_out": r.get("timed_out", False),
            "module_name": module_name,
        }


def pluscal_compile(tla_source: str, module_name: str = "Spec") -> dict[str, Any]:
    """Compile PlusCal algorithm to TLA+ using pcal.trans. Returns compiled source."""
    with tempfile.TemporaryDirectory(prefix="tla_harness_pcal_") as tmpdir:
        tla_path = Path(tmpdir) / f"{module_name}.tla"
        tla_path.write_text(tla_source, encoding="utf-8")
        r = _run_java("pcal.trans", [str(tla_path)], PCAL_TIMEOUT_S, cwd=tmpdir)

        compiled_path = Path(tmpdir) / f"{module_name}.tla"
        compiled_source = None
        if compiled_path.exists():
            compiled_source = compiled_path.read_text(encoding="utf-8")

        return {
            "ok": r.get("ok", False),
            "compiled_source": compiled_source,
            "exit_code": r.get("exit_code"),
            "stdout": r.get("stdout", ""),
            "stderr": r.get("stderr", ""),
            "timed_out": r.get("timed_out", False),
            "module_name": module_name,
        }


def tla_to_latex(tla_source: str, module_name: str = "Spec") -> dict[str, Any]:
    """Pretty-print TLA+ source to LaTeX using tla2tex.TLA."""
    with tempfile.TemporaryDirectory(prefix="tla_harness_tex_") as tmpdir:
        tla_path = Path(tmpdir) / f"{module_name}.tla"
        tla_path.write_text(tla_source, encoding="utf-8")
        r = _run_java("tla2tex.TLA", [str(tla_path)], TEX_TIMEOUT_S, cwd=tmpdir)

        latex_path = Path(tmpdir) / f"{module_name}.tex"
        latex_source = None
        if latex_path.exists():
            latex_source = latex_path.read_text(encoding="utf-8")

        return {
            "ok": r.get("ok", False),
            "latex_source": latex_source,
            "exit_code": r.get("exit_code"),
            "stdout": r.get("stdout", ""),
            "stderr": r.get("stderr", ""),
            "timed_out": r.get("timed_out", False),
            "module_name": module_name,
        }
