# Mermate Expert — Master Plan (Design Spec)

| | |
|---|---|
| **Status** | Draft v1 — sections 1–8 approved by stakeholder on 2026-05-02 |
| **Date** | 2026-05-02 |
| **Scope** | v1: Simple Idea → verified `.app` on Desktop, with Doctor verification, Playwright proof, and Opseeq trace |
| **Supersedes** | Per-stage Render UX (kept as power-user mode), `loading-overlay` full-canvas modal, agent-panel-only narration |
| **Implementation entry point** | After this spec is approved, `writing-plans` is invoked separately for each phase P0…P5 |

---

## 0. The Eureka

> **The events are the application.**

Mermate today produces artifacts (`.mmd`, `.tla`, `.ts`, binary, `.app`) and *also* logs what happened. Two parallel realities; they can drift. In Mermate Expert we invert this: every transformation emits a structured event, and every consumer — UI, Playwright, Doctor, Opseeq, and the running `.app` binary itself — reads from the same event vocabulary.

Three properties become free once that's true:

1. **Replay.** The event stream is the run; any past run can be replayed by re-emitting its events.
2. **Extensibility.** A CLI, IDE extension, CI runner, or mobile viewer is just another subscriber; no core rewrites.
3. **Proof.** Chain-of-custody is the canonical signed serialization of the event log. Opseeq does not invent proof; it just publishes the ledger.

The pipeline doesn't produce logs as a side effect — the pipeline *is* the log, materialized. The `.app` is a witness, not an output.

This is why the event bus is the spine of the plan, not a feature.

---

## 1. North Star

A user types one Simple Idea. Mermate drives six stages — `idea → md → mmd → tla → ts → rust → .app` — autonomously, with every step visible, addressable, testable, and provable. The user can pause at any stage to inspect or edit; otherwise the engine runs end-to-end. The final artifact is a `.app` on the Desktop whose runtime behavior validates the original idea, with a Doctor verdict, a Playwright self-test report, and an Opseeq proof document attached.

Done means: a one-line idea produces a working desktop application that the system itself can prove came from that idea.

---

## 2. Architectural Spine — Three Contracts

Everything else in this plan is mechanical once these three are correct.

### 2.1 `MermateBus` — the event spine

A canonical, server-emitted, SSE-transported, client-fanned-out event stream. Wraps the existing `server/services/audit-tracker.js` so we have one source of truth, not two.

#### Event vocabulary (v1)

```
build.run.start          { run_id, idea, options: { enhance, max, target: 'desktop' }, t }
build.run.complete       { run_id, summary: { stages, durations_ms, desktop_path }, t }
build.run.failed         { run_id, error, recoverable: bool, last_stage, t }

stage.enter              { run_id, stage, t }
stage.exit               { run_id, stage, ok, confidence, t }

stage.policy             { run_id, stage, max: bool, model, enhance: bool }
stage.transform          { run_id, stage, kind, before, after }
stage.role.start         { run_id, stage, role }
stage.role.thinking      { run_id, stage, role, summary }
stage.role.end           { run_id, stage, role, ok }

stage.image              { run_id, stage, kind: 'icon'|'hero', model, status: 'start'|'done'|'failed', path? }

verify.start             { run_id }
verify.check             { run_id, kind: 'name'|'behavior'|'visual'|'chain', ok, detail }
verify.complete          { run_id, verdict: { ok, name, behavior, visual, chain }, signed: bool }

opseeq.publish           { run_id, channel, payload_id }
```

Each event is a JSON object. `t` is `Date.now()`. `run_id` is the existing run UUID. Stages: `idea | md | mmd | tla | ts | rust | verify`.

#### Transport

- New endpoint: `GET /api/build/:run_id/events` — `Content-Type: text/event-stream`.
- Each event line: `event: <type>\ndata: <json>\n\n`.
- Heartbeat every 15s as `:heartbeat\n\n`.
- Closed by server on `build.run.complete | build.run.failed | verify.complete` (whichever is last per the run's plan).

#### Server emission

- `server/services/build-bus.js` exposes:
  ```js
  bus.emit(run_id, type, payload)
  bus.subscribe(run_id, fn) → unsubscribe
  bus.snapshot(run_id) → Event[]   // for late subscribers (replay)
  ```
- Existing render routes (`/api/render`, `/api/render/tla`, `/api/render/ts`, `/api/render/rust`) are wrapped to emit `stage.enter` / `stage.exit` and to call `bus.role.*` around each `provider.infer()`.
- The bus is **additive**. Removing all subscribers must not break a render. This is non-negotiable.

#### Client consumption

```js
import { MermateBus } from '/js/mermate-bus.js';

const bus = MermateBus.connect(runId);
bus.on('stage.transform', payload => { /* render diff */ });
bus.on('stage.role.thinking', payload => { /* update BuildLog row */ });
bus.onAny(event => { /* registry state updates */ });
bus.disconnect();
```

#### Why an event bus, not polling

Same stream powers (a) live UI, (b) Doctor input, (c) Playwright assertions, (d) Opseeq forwarding, (e) replay. One source of truth. Polling forces every consumer to invent its own derivation.

### 2.2 `MermateRegistry` — addressable components

Every meaningful element in `public/index.html` declares:

```html
data-mermate-id="build.log"
data-mermate-version="1.0"
data-mermate-state="idle"   <!-- idle | streaming | complete | error | locked -->
```

Naming is **dotted, namespaced, stable**:

| Family | Example IDs |
|---|---|
| Build log | `build.log`, `build.log.row.<n>` |
| Stage badges | `stage.badge.idea`, `stage.badge.tla`, … |
| Roles | `build.log.role.Doctor_Mermaid`, `build.log.role.Doctor_Validator` |
| Transforms | `transform.idea-md`, `transform.md-mmd`, … |
| Images | `image.preview.icon`, `image.preview.hero` |
| Verification | `verify.verdict`, `verify.check.name`, `verify.check.behavior`, … |
| Engine | `engine.button.build`, `engine.button.pause`, `engine.policy.enhance`, `engine.policy.max` |

Versions allow non-breaking evolution: when a component changes shape, bump `data-mermate-version`; deprecated selector remains queryable for one release window.

### 2.3 `MermateInspector` — the query API

Exposed on `window` for devtools and Playwright; importable for internal subscribers.

```ts
type InspectorSnapshot = { id: string; version: string; state: string; text: string }[];

window.MermateInspector = {
  find(id: string): Element | null,
  findAll(prefix?: string): Element[],
  findByState(state: string): Element[],
  snapshot(): InspectorSnapshot,
  awaitState(id: string, state: string, opts: { timeoutMs: number }): Promise<Element>,
  subscribe(eventType: string, cb: (payload: unknown) => void): () => void,
  on(idPattern: string, cb: (el: Element, event: { type: string; payload: unknown }) => void): () => void,
};
```

`awaitState` is the killer for Playwright — assertions become semantic (await `verify.verdict` to reach `complete` state) instead of DOM-scraping.

---

## 3. The Build Engine

### 3.1 `BuildEngine` (client controller)

```
BuildEngine.run(idea, {
  enhance: bool,
  max: bool,
  pauseAt: Stage[],          // ['mmd'] means pause for inspection after Mermaid stage
  target: 'desktop',
})
```

Drives:

```
idea → (enhance?) → md → mmd → tla → ts → rust → .app → verify
```

State machine (mirrors `WorkflowOrchestrator` but as a controller, not a passive store):

```
        ┌──────── pause(stage) ────────┐
        ▼                              │
idle ─► running ─► paused ─► running ─►│ … ─► complete
                                       │           │
                                       └─► failed ◄┘
```

Existing per-stage Render buttons remain wired to the same routes; they're the **power-user / debug** path. The default UX is a single **Build** button that invokes `BuildEngine.run`. Pause points are configurable per-run (default: no pauses; full chain).

### 3.2 Enhance + Max are first-class events

Today these toggles silently change behavior. In v1:

- Toggling Enhance emits `stage.policy { enhance: true }`. UI shows an "Enhance engaged" chip in BuildLog header.
- Toggling Max emits `stage.policy { max: true, model: '<resolved>' }`. UI shows the resolved model name.
- The idea→markdown transformation under Enhance renders as a **before/after diff card** inside BuildLog (component id `transform.idea-md`). Not behind a spinner.

### 3.3 Visible thinking, by construction

Every server-side `provider.infer()` call inside a render route is wrapped:

```js
bus.emit(run_id, 'stage.role.start',    { stage, role });
const result = await provider.infer(...);
bus.emit(run_id, 'stage.role.thinking', { stage, role, summary: summarize(result) });
bus.emit(run_id, 'stage.role.end',      { stage, role, ok: !!result.output });
```

This means the standard render path narrates as fully as the explicit Agent mode does today — restoring the "agents thinking while building" UX.

### 3.4 Loading overlay → inline progress chip

`#loading-overlay` (full-canvas modal with backdrop blur) is removed. Replacement: an inline progress chip docked in the BuildLog header. State driven by `data-mermate-state="streaming"` on `build.log` and per-stage badges. Never covers more than 25% of the viewport. Hard requirement; tested by Playwright.

---

## 4. Five Subsystems

Each becomes its own implementation plan via `writing-plans` after this master plan is approved.

### M1 — Foundation: Bus + Registry + Inspector + BuildLog UI

| Deliverable | Path |
|---|---|
| Bus singleton (server) | `server/services/build-bus.js` |
| SSE route | `server/routes/build-events.js` (mounts at `/api/build/:run_id/events`) |
| audit-tracker integration | extend `server/services/audit-tracker.js` to forward to bus |
| Bus client | `public/js/mermate-bus.js` |
| Registry | `public/js/mermate-registry.js` |
| Inspector | `public/js/mermate-inspector.js` |
| BuildLog component | `public/js/mermate-build-log.js` |
| Render-path role narration | refactor `server/routes/render.js`, `tla.js`, `ts.js`, `rust.js` to call bus around each `provider.infer` |
| HTML tagging | `public/index.html` — add `data-mermate-*` to every meaningful node |
| CSS | `public/css/mermaid-gpt.css` — replace `.loading-overlay` with `.build-log-progress-chip` |

**Acceptance for M1:** with no other changes, every existing render produces a live event stream consumable via `curl -N /api/build/:run_id/events`, and `MermateInspector.snapshot()` returns ≥30 tagged components.

### M2 — Build Engine: idea → `.app` one-click

| Deliverable | Path |
|---|---|
| Client engine | `public/js/mermate-build-engine.js` |
| Build button + policy chips | `public/index.html` (additions, no removals) |
| Per-stage transform cards | `public/js/mermate-build-log.js` extension |
| Image preview cards | `public/js/mermate-build-log.js` (icon/hero thumbnails arrive via `stage.image`) |
| Pause/resume controls | `public/js/mermate-build-engine.js` |
| Server pre-warm | optional: a single `/api/build/start` that creates the run_id before stage 1 (so SSE can open before any inference) |

**Acceptance for M2:** typing one idea + pressing Build produces a `.app` on Desktop with no further user action; BuildLog shows transform diffs for every stage; icon thumbnail visible during Rust stage.

### M3 — Doctor verifier

| Deliverable | Path |
|---|---|
| Verifier service | `server/services/doctor-verifier.js` |
| Route | `server/routes/doctor.js` (`POST /api/doctor/verify/:run_id`) |
| Role registration | extend `server/services/role-registry.js` with `Doctor_Verifier` |
| Verdict artifact | `runs/<run_id>.verify.json` and copied to `<.app>/Contents/Resources/verify.json` |
| BuildLog verdict card | `mermate-build-log.js` consumes `verify.complete` |

**Four checks:**

1. `name` — Doctor reads original idea + chosen diagram name, asserts the name semantically matches intent.
2. `behavior` — runs the binary, captures stdout, asserts TLA invariants surfaced in output.
3. `visual` — confirms the dashboard renders by hitting the launcher URL and checking for non-empty body.
4. `chain` — walks the run JSON and confirms every stage transition has matching `stage.enter`/`stage.exit` events.

Verdict is signed (HMAC over the canonical event log) and written next to the `.app`.

**Acceptance for M3:** running Doctor against a successful run produces `verdict.ok === true` for all four checks. Tampering with any artifact (e.g., editing the `.tla` file) flips the corresponding check to false.

### M4 — Playwright harness

| Deliverable | Path |
|---|---|
| Playwright config | `playwright.config.ts` |
| E2E spec | `test/e2e/build-full-chain.spec.ts` |
| Fixtures | `test/e2e/fixtures/{todo,payment,auth}.txt` |
| npm scripts | `package.json` adds `test:e2e`, `test:e2e:headed` |
| Reporter output | `test/e2e/_artifacts/<run_id>/{report.html,screenshots/,verify.json}` |

**Spec outline:**

```
test('idea → .app full chain', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-mermate-id="engine.policy.enhance"]').click();
  await page.locator('[data-mermate-id="input.idea"]').fill(fixtureText);
  await page.locator('[data-mermate-id="engine.button.build"]').click();

  // Semantic awaits, no DOM scraping
  for (const stage of ['idea','md','mmd','tla','ts','rust','verify']) {
    await page.evaluate(s => window.MermateInspector.awaitState(`stage.badge.${s}`, 'complete', { timeoutMs: 600_000 }), stage);
    await page.screenshot({ path: `test/e2e/_artifacts/${runId}/screenshots/${stage}.png` });
  }

  // Open the .app and screenshot its dashboard
  // Assertions on Doctor verdict and viewport coverage
});
```

**Acceptance for M4:** `npm run test:e2e` produces a passing report for at least 2 of 3 fixtures; failures produce diagnostic artifacts.

### M5 — Opseeq full-chain proof

| Deliverable | Path |
|---|---|
| Bus → Opseeq forwarder | extend `server/services/opseeq-bridge.js` |
| Proof route | `server/routes/opseeq-proof.js` (`GET /api/opseeq/proof/:run_id`) |
| Proof signer | `server/services/proof-signer.js` (HMAC over canonical event log) |
| BuildLog proof card | consumes `opseeq.publish` |

**Proof document shape:**

```json
{
  "run_id": "...",
  "idea": "A todo list app...",
  "stages": [{ "stage": "md", "enter_t": ..., "exit_t": ..., "ok": true }, ...],
  "artifacts": { "mmd": "...", "tla": "...", "ts": "...", "rust_binary": "...", "app_bundle": "..." },
  "verdict": { "ok": true, "name": true, "behavior": true, "visual": true, "chain": true },
  "playwright": { "report": "...", "screenshots": [...], "passed": true },
  "events_hash": "sha256:...",
  "signature": "hmac-sha256:..."
}
```

**Acceptance for M5:** for any run that passes Doctor + Playwright, `/api/opseeq/proof/:run_id` returns a complete signed proof document with no missing links.

---

## 5. Phasing

| Phase | Subsystem | Days | Depends on | Output |
|---|---|---|---|---|
| P0 | M1 foundation (bus, registry, inspector, BuildLog skeleton, SSE route) | 5 | — | live event stream consumable |
| P1 | M1 visible thinking on standard render path; loading-overlay replaced | 3 | P0 | one-click Render shows live agent thinking again |
| P2 | M2 BuildEngine end-to-end with pause points and policy chips | 4 | P1 | one-click idea → `.app` |
| P3 | M3 Doctor verifier (four checks + signed verdict) | 3 | P2 | `verify.json` next to `.app` |
| P4 | M4 Playwright harness (3 fixtures) | 3 | P0 (uses Inspector); meaningful only after P2 | `npm run test:e2e` green |
| P5 | M5 Opseeq proof binding + signed proof endpoint | 2 | P3 + P4 | `/api/opseeq/proof/:run_id` |

**Total ~20 working days.** P3 and P4 can run in parallel after P2; P5 is the final stitch.

Each phase begins with `writing-plans` producing a per-phase implementation plan with file-by-file diffs and acceptance tests.

---

## 6. Acceptance — single integration test

`npm run test:e2e -- --grep "expert-master"` runs:

> Type `"A todo list app where users add tasks and complete them"` into Simple Idea, click Build, wait.
>
> All eight must hold:
>
> 1. BuildLog renders streaming `stage.role.thinking` events for ≥3 distinct `Doctor_*` roles.
> 2. `transform.idea-md` card shows visible before/after diff (not a spinner).
> 3. DALL-E icon thumbnail appears in `image.preview.icon` within 60s of `stage.image` start.
> 4. A `.app` bundle is deployed to `~/Desktop/`.
> 5. Doctor `verify.complete` payload has `verdict.ok === true` for all four checks.
> 6. `/api/opseeq/proof/:run_id` returns a signed chain document with no missing links.
> 7. Playwright artifact exists: `report.html` + 7 stage screenshots + `verify.json`.
> 8. `loading-overlay` covers ≤25% of viewport at every screenshot.

If all eight hold for one full chain, Mermate Expert v1 is shipped.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| SSE refactor breaks existing flows | Bus is **additive**; existing routes return their existing JSON responses. Removing all subscribers must not regress behavior — covered by `test/test-render-api.js`. |
| `data-mermate-*` attributes proliferate inconsistently | A lint pass in P1 enforces every interactive element has an id. A pre-commit hook flags untagged additions. |
| BuildEngine swallows individual stage errors | Every stage failure emits `stage.exit { ok: false }` and surfaces in BuildLog with the existing `error-banner`. Hard fail visible. |
| Playwright flakes on AI nondeterminism | `awaitState` over the registry, not text matching. State machine is deterministic even when text is not. |
| Doctor false positives | `behavior` check actually runs the binary and asserts on TLA invariants. The proof TLC already gives us, surfaced as a check. |
| Master plan rots if subsystems drift | Every implementation plan must list which `MermateBus` events it produces/consumes. PR template includes the question. |
| SSE connection drops during long Rust compile | Server replays event history via `bus.snapshot(run_id)` on reconnect. Client falls back to a single GET if SSE closes. |
| Component version churn breaks Playwright | Selectors written as `[data-mermate-id="..."]` with optional version constraints; one-release deprecation window. |

---

## 8. Explicit Non-Goals (v1)

- No drag-and-drop reordering of panels.
- No multi-user collaboration on a single run.
- No remote `.app` deployment (Desktop only).
- No mobile UI.
- No replacement of the Mermaid library or rendering pipeline.
- No removal of per-stage Render buttons (power-user path stays).
- No replacement of the existing `WorkflowOrchestrator`; the BuildEngine is layered on top, not a replacement.
- No replacement of `audit-tracker.js`; the bus wraps it.

---

## 9. Open Questions (to resolve before P0 plan)

1. Should `MermateBus` events be persisted per-run as a flat NDJSON file (`runs/<run_id>.events.ndjson`) for offline replay? *Recommendation: yes; trivially adds `bus.snapshot()` durability.*
2. Should `Doctor_Verifier` use the same model class as `Doctor_Mermaid` (premium) or a cheaper validator-tier model? *Recommendation: premium; verification is the value proposition.*
3. Should the Build button replace the per-stage Render buttons by default, or live alongside? *Recommendation: live alongside. Build is primary; Render is secondary in a "power user" disclosure.*

These resolve at the start of P0.

---

## 10. Glossary

| Term | Definition |
|---|---|
| **MermateBus** | The canonical event spine. Server-emitted, SSE-transported. |
| **MermateRegistry** | Index of every UI element with `data-mermate-*` attributes. |
| **MermateInspector** | Public window-level query API over the registry. |
| **BuildEngine** | Client controller that drives the six-stage chain. |
| **BuildLog** | Always-visible UI component that renders the live event stream. |
| **Doctor** | Verifier role producing a signed verdict from the event log + binary behavior. |
| **Playwright artifact** | Auto-generated HTML report + screenshots + verdict from the E2E test. |
| **Opseeq proof** | Signed canonical serialization of the run's event log + artifacts. |
| **Stage** | One of: `idea`, `md`, `mmd`, `tla`, `ts`, `rust`, `verify`. |
| **Power-user mode** | Existing per-stage Render buttons; preserved alongside the Build engine. |

---

*End of master plan. Implementation begins after stakeholder review of this document and `writing-plans` produces the P0 plan.*
