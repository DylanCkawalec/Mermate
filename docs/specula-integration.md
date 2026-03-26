# Specula Integration

This repository now treats Specula as the reference workflow for the formal stage of the Mermate pipeline.

Upstream reference:

- Repo: `https://github.com/DylanCkawalec/Specula`
- Branch: `main`
- Reference commit: `72d0b3d4c27d10d7f4eba18ca11647b57ae84fbe`

Integrated ideas:

1. `code_analysis` style handoff becomes a structured `modeling-brief.json` and `modeling-brief.md`.
2. Base TLA output is preserved, then wrapped into separate MC, trace, and instrumentation artifacts.
3. Validation is recorded as an explicit loop artifact instead of hidden route state.
4. TLA-specific repair uses `CLAUDE_API_KEY` only. It does not fall back to `OPENAI_API_KEY`.

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

Pipeline layout:

`idea -> architecture.md -> architecture.mmd -> tsx-app/ -> specula/ -> ts-runtime/`
