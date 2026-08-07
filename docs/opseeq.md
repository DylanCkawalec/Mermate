# Opseeq integration notes

Everything Opseeq-specific lives here so the README stays product-focused.
**Opseeq is optional** — Mermate runs fully without it (direct OpenAI,
Ollama, or the Python enhancer all work standalone).

## What Opseeq is (in this stack)

An OpenAI-compatible gateway + management API that Mermate can route
inference through. When deployed, it adds: centralized model routing,
correlated logs across services, and low-latency stage telemetry.

## URL rules (the part everyone gets wrong)

| Variable | Value | Rule |
|---|---|---|
| `OPSEEQ_URL` | `http://localhost:9090` | **Service root — NO `/v1`.** Used for `/health`, `/api/...`, stage-event forwarding. Inference appends `/v1` internally. |
| `OPENAI_BASE_URL` | `http://localhost:9090/v1` | Optional override for the **inference** base only. **Must include `/v1`.** Only set it when the inference base differs from `OPSEEQ_URL` + `/v1`. |

## Model resolution caveat

A gateway can legally resolve a requested model name to a different
serving model (e.g. request `gpt-5.6-terra`, serve `gpt-5.2`). When
debugging quality, cost, or latency, trust the **response `model` field**
and `runs/<run_id>.json → agent_calls[*].model` — not the model name in
the request payload.

## Gateway fallback

When premium traffic targets Opseeq and the gateway errors (5xx, rate
limits after retries), the provider may fall back to **direct OpenAI**.
The render API then returns `fallback_events` and the UI shows a short
notice. While a render run is active, premium requests send
**`X-Request-Id` = the Mermate `run_id`** for cross-service log
correlation.

## Stage traces and run lineage

- `POST /api/mermate/stage` — ingest a stage event (local store)
- `GET /api/mermate/trace/:run_id` — stage event timeline
- `GET /api/mermate/trace-stats` — aggregate stats
- `GET /api/runs`, `GET /api/runs/:run_id`, `GET /api/runs/:run_id/summary` — run lineage, per-stage agent-call summaries, token/cost estimates
- `GET /api/openclaw/ws-status` — snapshot of the Mermate → Opseeq WebSocket bridge

The full correlation contract (shared `run_id` / `X-Request-Id`, URL
normalization, packaging) is in
[docs/tandem-opseeq-protocol.md](tandem-opseeq-protocol.md).

## WebSocket telemetry (optional)

```env
OPSEEQ_WS_ENABLED=true
OPSEEQ_WS_URL=ws://localhost:9090/api/mermate/ws
OPSEEQ_WS_TOKEN=<optional-token>
```

`server/services/opseeq-ws-bridge.js` forwards stage events at low
latency. Polling over HTTP is the default; the WS bridge is an
optimization, not a requirement.

## Boot gate and idle behavior

The frontend boot sequence polls Opseeq until healthy **if it is
configured** — with backoff and a bounded attempt budget; the app still
boots without it. A centralized `RuntimeState` tracker gates all periodic
pollers (Opseeq heartbeat every 20s, autoguide every 5s): when the app is
idle (no agent running, no loading, no user interaction for 60s), all API
calls stop completely.

## Helper scripts

```bash
npm run opseeq:status        # probe gateway health + config
npm run opseeq:docker:build  # build the Opseeq docker image (if colocated)
```

## Related

- [docs/tandem-opseeq-protocol.md](tandem-opseeq-protocol.md) — the MERMATE ↔ Opseeq correlation protocol
- `server/services/opseeq-bridge.js` — health, inference proxy helpers, `reportStage`
- `server/services/opseeq-ws-bridge.js` — optional WebSocket stage telemetry
