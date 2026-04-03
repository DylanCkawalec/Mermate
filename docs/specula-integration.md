# Specula Integration

This repository treats Specula as the reference workflow for the formal stage of the Mermate pipeline.

Upstream reference:

- Repo: `https://github.com/DylanCkawalec/Specula`
- Branch: `main`
- Reference commit: `72d0b3d4c27d10d7f4eba18ca11647b57ae84fbe`

Integrated ideas:

1. `code_analysis` style handoff becomes a structured `modeling-brief.json` and `modeling-brief.md`.
2. Base TLA output is preserved, then wrapped into separate MC, trace, and instrumentation artifacts.
3. Validation is recorded as an explicit loop artifact instead of hidden route state.
4. TLA-specific LLM stages use `CLAUDE_API_KEY` (Anthropic). They do not fall back to `OPENAI_API_KEY`.
5. **TLA+ module text** is produced primarily by **Claude** (`generateTlaSpec` in `server/services/specula-llm.js`) when the key is present, with the deterministic TLA compiler as fallback if generation fails.
6. After deterministic **TypeScript runtime** generation, an **optional Claude review** may reconcile TS with the TLA+ spec (`server/routes/ts.js`).

Cross-service tracing, `OPSEEQ_URL` rules, stage events, and the Rust/desktop packaging path are documented in [tandem-opseeq-protocol.md](./tandem-opseeq-protocol.md).

JSON artifacts under `specula/` (`modeling-brief.json`, `validation-loop.json`, `index.json`) default to **compact** serialization for smaller files and faster I/O. Set `MERMATE_SPECULA_JSON_PRETTY=1` for indented output.

Artifact layout under `flows/<diagram>/specula/`:

- `modeling-brief.md`
- `modeling-brief.json`
- `base.tla`
- `base.cfg`
- `MC.tla`
- `MC.cfg`
- `MC_hunt_*.cfg`
- `Trace.tla`
- `Trace.cfg`
- `instrumentation-spec.md`
- `validation-loop.json`

Pipeline layout (high level):

`idea -> architecture.md -> architecture.mmd -> specula/ (TLA+) -> ts-runtime/ (TypeScript) -> rust-binary/ (optional) -> desktop .app + skill.json + landing dashboard`
