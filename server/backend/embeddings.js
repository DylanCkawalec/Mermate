'use strict';

const logger = require('../utils/logger');

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const MAX_TOKENS_PER_INPUT = 8191;
const MAX_BATCH = 20;

function _getApiKey() {
  return process.env.OPENAI_API_KEY || process.env.MERMATE_AI_API_KEY || '';
}

function _estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}

function _truncateToTokenLimit(text) {
  const est = _estimateTokens(text);
  if (est <= MAX_TOKENS_PER_INPUT) return text;
  const charLimit = Math.floor(MAX_TOKENS_PER_INPUT * 3.5);
  return text.slice(0, charLimit);
}

async function embed(text) {
  const key = _getApiKey();
  if (!key) {
    logger.warn('embeddings.no_api_key');
    return { vector: new Float32Array(DIMENSIONS), tokenCount: 0 };
  }

  const truncated = _truncateToTokenLimit(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ model: MODEL, input: truncated }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn('embeddings.api_error', { status: res.status });
      return { vector: new Float32Array(DIMENSIONS), tokenCount: 0 };
    }

    const data = await res.json();
    const vec = data.data?.[0]?.embedding;
    const tokens = data.usage?.total_tokens || _estimateTokens(truncated);

    return {
      vector: new Float32Array(vec || new Array(DIMENSIONS).fill(0)),
      tokenCount: tokens,
    };
  } catch (err) {
    logger.warn('embeddings.error', { error: err.message });
    return { vector: new Float32Array(DIMENSIONS), tokenCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function embedBatch(texts) {
  const key = _getApiKey();
  if (!key || texts.length === 0) {
    return texts.map(() => ({ vector: new Float32Array(DIMENSIONS), tokenCount: 0 }));
  }

  const results = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map(t => _truncateToTokenLimit(t));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({ model: MODEL, input: batch }),
        signal: controller.signal,
      });

      if (!res.ok) {
        logger.warn('embeddings.batch_error', { status: res.status, batchSize: batch.length });
        for (const _ of batch) results.push({ vector: new Float32Array(DIMENSIONS), tokenCount: 0 });
        continue;
      }

      const data = await res.json();
      const sorted = (data.data || []).sort((a, b) => a.index - b.index);

      for (let j = 0; j < batch.length; j++) {
        const vec = sorted[j]?.embedding;
        results.push({
          vector: new Float32Array(vec || new Array(DIMENSIONS).fill(0)),
          tokenCount: data.usage?.total_tokens ? Math.round(data.usage.total_tokens / batch.length) : _estimateTokens(batch[j]),
        });
      }
    } catch (err) {
      logger.warn('embeddings.batch_error', { error: err.message });
      for (const _ of batch) results.push({ vector: new Float32Array(DIMENSIONS), tokenCount: 0 });
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

module.exports = { embed, embedBatch, DIMENSIONS, MODEL };
