# ADR 0001: Ports and Adapters Architecture for Mermate Pipeline

## Status
Accepted

## Context
The Mermate pipeline was previously tightly coupled to live infrastructure dependencies (OpenAI API, Ollama, Python enhancer, filesystem, and Docker toolchains). This made automated testing slow, flaky, costly, and reliant on network connectivity or API key configuration.

To support deterministic, sub-10-second regression testing and allow offline development on local environments without sacrificing production capabilities, we required an architectural refactoring separating core pipeline reasoning logic from concrete infrastructure providers.

## Decision
We adopted a Ports and Adapters (Hexagonal Architecture) design pattern for the Mermate pipeline:

1. **Pipeline Ports Interface (`server/services/ports.js`)**:
   - `InferencePort`: Abstracts model inference calls (`infer`, `inferMax`, `inferWithRole`).
   - `RunTrackerPort`: Abstracts telemetry and agent call tracing (`addStage`, `recordAgentCall`, `recordRateEvent`, `recordMerge`).
   - `CompilerPort`: Abstracts diagram syntax validation and image compilation (`compile`, `validate`).
   - `PipelinePorts`: Master container object injected into pipeline functions.

2. **Dual Adapter Implementations**:
   - **Production Adapters**: Wrap real services (`inference-provider`, `run-tracker`, `mermaid-compiler`, `mermaid-validator`).
   - **Fake/Test Adapters (`test/lib/fake-inference-provider.js`, `test/lib/noop-run-tracker.js`, `test/lib/fake-compiler.js`)**: Record and replay deterministic fixtures, running sub-second offline tests with zero API cost.

3. **Record/Replay Regression Harness (`test/fixtures/regression-fixtures.json`)**:
   - Automatically replays recorded scenario outputs during test execution.
   - Env flag `MERMATE_RECORD=1` or `MERMATE_RECORD_FIXTURES=1` triggers live calls to update recorded fixtures.

## Consequences

### Positive
- Sub-10-second, zero-cost, fully deterministic regression tests running locally and in CI.
- Clean separation of concerns between GoT pipeline reasoning logic and infrastructure adapters.
- Easy to swap in local LLMs, mock compilers, or custom telemetry trackers without changing pipeline code.
- Contract test suite guarantees that fake adapters and production adapters maintain behavioral parity.

### Negative / Trade-offs
- Adds adapter parameters or dependency injections to central pipeline entry points.
- Requires maintaining fixtures when prompt schemas or stage definitions change.
