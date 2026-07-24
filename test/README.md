# Mermate Test & Regression Suite

This directory contains Mermate's test harness, including unit tests, contract tests, performance regression tests, and a deterministic record/replay harness.

---

## Test Commands

| Command | Description | Latency |
|---|---|---|
| `npm run test:regression` | Runs offline regression pipeline tests against recorded LLM fixtures | < 5 sec |
| `npm run test:fast` | Runs fast unit & validator tests | < 5 sec |
| `npm run test:compile` | Runs compiler, repair, and render integration tests | < 10 sec |
| `npm run test:ci` | Runs full CI test gate (`test:regression` + `test:fast` + `test:compile`) | < 15 sec |
| `npm run test:record` | Re-records live LLM responses into `test/fixtures/regression-fixtures.json` | Depends on API |

---

## Record & Replay Workflow

The regression harness uses `FakeInferenceProvider` (`test/lib/fake-inference-provider.js`).

### Default Mode: Replay
In replay mode (default), test runs look up pre-recorded fixture outputs from `test/fixtures/regression-fixtures.json` using a SHA-256 hash key based on `stage` and `userPrompt`.
- Zero network I/O
- Zero API cost
- Deterministic output

### Record Mode
To record new live responses from your configured LLM provider:
```bash
MERMATE_RECORD=1 npm run test:regression
# OR
npm run test:record
```
When `MERMATE_RECORD=1` is set, calls execute against real LLMs (OpenAI / Ollama) and automatically save updated responses back into `test/fixtures/regression-fixtures.json`.

---

## Test Directory Structure

- `test/lib/fake-inference-provider.js` — Record/Replay LLM provider adapter
- `test/lib/noop-run-tracker.js` — In-memory telemetry recorder
- `test/lib/fake-compiler.js` — Compiler adapter for tests
- `test/fixtures/regression-fixtures.json` — Pre-recorded scenario responses
- `test/test-regression-pipeline.js` — High-level pipeline scenario test suite
- `test/test-contract-inference.js` — Contract test for inference port parity
- `test/test-contract-run-tracker.js` — Contract test for run tracker parity
- `test/test-contract-compiler.js` — Contract test for compiler port parity
- `test/test-perf-regression.js` — Latency budgets and memory stability tests
