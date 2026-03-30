'use strict';

const logger = require('../utils/logger');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.MERMATE_TLA_CLAUDE_MODEL
  || process.env.CLAUDE_MODEL
  || 'claude-3-7-sonnet-latest';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.MERMATE_TLA_CLAUDE_TIMEOUT_MS || '120000', 10);

function getConfig() {
  return {
    provider: 'anthropic',
    apiKeyPresent: Boolean(CLAUDE_API_KEY),
    model: CLAUDE_MODEL,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  };
}

function isAvailable() {
  return Boolean(CLAUDE_API_KEY);
}

async function inferTlaStage(stage, { systemPrompt, userPrompt, maxTokens = 8192 }) {
  if (!CLAUDE_API_KEY) {
    return {
      available: false,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: null,
      error: 'CLAUDE_API_KEY is not configured',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        system: systemPrompt || '',
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: userPrompt || '',
          },
        ],
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    const text = Array.isArray(payload.content)
      ? payload.content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text || '')
        .join('\n')
        .trim()
      : null;

    if (!response.ok) {
      const details = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      logger.warn('specula_llm.request_failed', { stage, details });
      return {
        available: true,
        provider: 'anthropic',
        model: CLAUDE_MODEL,
        output: null,
        error: details,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      available: true,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: text,
      error: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    logger.warn('specula_llm.request_error', { stage, error: err.message });
    return {
      available: true,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: null,
      error: err.message,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getConfig,
  isAvailable,
  inferTlaStage,
};
