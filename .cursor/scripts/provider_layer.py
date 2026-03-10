"""Provider layer for model inference routing.

Abstracts over local gpt-oss inference and external API providers.
Reads configuration from environment variables:
  - MERMATE_AI_API_KEY: API key for external provider
  - MERMATE_AI_MODEL: routine model (e.g. gpt-4o-mini)
  - MERMATE_AI_MAX_MODEL: premium model for render-critical steps
  - MERMATE_AI_MAX_ENABLED: whether premium model is available

Degrades gracefully: premium -> routine -> deterministic fallback.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

log = logging.getLogger("mermaid_enhancer.provider")

_ENV_FILE = Path(__file__).parent.parent / ".env"


class ModelTier(Enum):
    ROUTINE = "routine"
    PREMIUM = "premium"


@dataclass
class ModelConfig:
    api_key: str
    routine_model: str
    premium_model: str
    premium_enabled: bool

    @property
    def has_api_access(self) -> bool:
        return bool(self.api_key and self.api_key.startswith("sk-"))


@dataclass
class InferenceResult:
    text: str
    model_used: str
    tier: ModelTier
    latency_ms: float
    token_count_estimate: int
    success: bool
    error: str = ""

    @property
    def is_json(self) -> bool:
        try:
            json.loads(self.text)
            return True
        except (json.JSONDecodeError, TypeError):
            return False

    def parse_json(self) -> dict[str, Any]:
        text = self.text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        return json.loads(text)


def load_config() -> ModelConfig:
    """Load provider config from environment, falling back to .env file."""
    api_key = os.environ.get("MERMATE_AI_API_KEY", "")
    routine = os.environ.get("MERMATE_AI_MODEL", "gpt-4o-mini")
    premium = os.environ.get("MERMATE_AI_MAX_MODEL", "")
    enabled = os.environ.get("MERMATE_AI_MAX_ENABLED", "false")

    if not api_key and _ENV_FILE.exists():
        for line in _ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if key == "MERMATE_AI_API_KEY" and not api_key:
                    api_key = value
                elif key == "MERMATE_AI_MODEL" and routine == "gpt-4o-mini":
                    routine = value
                elif key == "MERMATE_AI_MAX_MODEL" and not premium:
                    premium = value
                elif key == "MERMATE_AI_MAX_ENABLED":
                    enabled = value

    return ModelConfig(
        api_key=api_key,
        routine_model=routine,
        premium_model=premium,
        premium_enabled=enabled.lower() in ("true", "1", "yes"),
    )


_config: ModelConfig | None = None


def get_config() -> ModelConfig:
    global _config
    if _config is None:
        _config = load_config()
    return _config


def reset_config() -> None:
    global _config
    _config = None


async def complete(
    system: str,
    user: str,
    *,
    tier: ModelTier = ModelTier.ROUTINE,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    response_format: str | None = None,
) -> InferenceResult:
    """Run a model completion through the provider layer.

    Tries the requested tier, falls back through available options.
    """
    config = get_config()

    if not config.has_api_access:
        return InferenceResult(
            text="",
            model_used="none",
            tier=tier,
            latency_ms=0,
            token_count_estimate=0,
            success=False,
            error="No API key configured",
        )

    model = _select_model(config, tier)
    start = time.monotonic()

    try:
        text = await _call_openai(
            config.api_key,
            model,
            system,
            user,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
        )
        elapsed = (time.monotonic() - start) * 1000
        token_est = len(text.split()) * 4 // 3

        return InferenceResult(
            text=text,
            model_used=model,
            tier=tier,
            latency_ms=round(elapsed, 1),
            token_count_estimate=token_est,
            success=True,
        )

    except Exception as exc:
        elapsed = (time.monotonic() - start) * 1000
        log.warning("Provider call failed (model=%s): %s", model, exc)

        if tier == ModelTier.PREMIUM and config.routine_model != model:
            log.info("Falling back from premium to routine model")
            return await complete(
                system,
                user,
                tier=ModelTier.ROUTINE,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format=response_format,
            )

        return InferenceResult(
            text="",
            model_used=model,
            tier=tier,
            latency_ms=round(elapsed, 1),
            token_count_estimate=0,
            success=False,
            error=str(exc),
        )


def _select_model(config: ModelConfig, tier: ModelTier) -> str:
    if tier == ModelTier.PREMIUM and config.premium_enabled and config.premium_model:
        return config.premium_model
    return config.routine_model


async def _call_openai(
    api_key: str,
    model: str,
    system: str,
    user: str,
    *,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    response_format: str | None = None,
) -> str:
    """Call OpenAI-compatible API. Uses httpx for async."""
    try:
        import httpx
    except ImportError:
        import subprocess
        subprocess.check_call(["pip", "install", "httpx"], capture_output=True)
        import httpx

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    if response_format == "json_object":
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    choices = data.get("choices", [])
    if not choices:
        raise ValueError("Empty response from API")

    return choices[0]["message"]["content"]


def is_available(tier: ModelTier = ModelTier.ROUTINE) -> bool:
    """Check if a given model tier is configured and available."""
    config = get_config()
    if not config.has_api_access:
        return False
    if tier == ModelTier.PREMIUM:
        return config.premium_enabled and bool(config.premium_model)
    return True
