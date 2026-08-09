---- MODULE MermateOrchestrator ----
(***************************************************************************)
(* Mermate Orchestrator — control-plane design specification.              *)
(*                                                                         *)
(* System modeled: the Mermate session control plane — the client-side     *)
(* workflow FSM (stages idea -> md -> mmd -> tla -> ts), the SSE agent     *)
(* pipeline that produces stage artifacts, the TLA+ verification gate,     *)
(* and the localStorage persistence layer with its failure/recovery        *)
(* semantics. This is the design the code must conform to; every           *)
(* invariant below names a regression that actually occurred in the        *)
(* implementation and is now barred by construction.                       *)
(*                                                                         *)
(* ABSTRACTION DECISIONS (required reading before the module):             *)
(*                                                                         *)
(* 1. Artifact CONTENT is abstracted to presence (BOOLEAN per stage).      *)
(*    Every property of interest — no lost user data, no TS before         *)
(*    verified TLA+, no silent persistence failure — is a property of      *)
(*    presence, unlock set, and durability, never of bytes. A finer        *)
(*    model of content would multiply the state space without changing     *)
(*    a single verdict.                                                    *)
(*                                                                         *)
(* 2. GRAIN OF ATOMICITY: one step is one user gesture (edit, tab          *)
(*    switch, enhance, verify request), one agent stage emission, or one   *)
(*    persistence event. SSE frame boundaries, provider retries,           *)
(*    typewriter animation, and debounce timers are sub-atomic: no         *)
(*    property mentions them. The single client and the per-session        *)
(*    serialized agent make finer interleavings unobservable.              *)
(*                                                                         *)
(* 3. The verifier is modeled as a gate, not a process. SANY/TLC           *)
(*    internals are invisible; what matters is (a) verification happens    *)
(*    ONLY on explicit user authorization (never on tab switch — the       *)
(*    652-second auto-TLC regression), and (b) the TS stage is reachable   *)
(*    only after it succeeds.                                              *)
(*                                                                         *)
(* 4. Persistence is modeled as volatile memory (mem) vs durable store     *)
(*    (disk) with an explicit health flag. The contract — every            *)
(*    mutation is synchronously durable while healthy, and any failure     *)
(*    is surfaced to the user — is stated ONCE, in SyncDisks, and shared   *)
(*    by every mutating action. The previous implementation's silent       *)
(*    catch{} quota drop is unrepresentable in this model.                 *)
(*                                                                         *)
(* 5. Session lineage (runId, diagramName, paths) is deliberately          *)
(*    omitted: it identifies artifacts but does not guard any safety       *)
(*    property. The boot reattach protocol is represented by Reload        *)
(*    (volatile := durable) and the agent flag surviving reload.           *)
(*                                                                         *)
(* SAMPLE BEHAVIOR 1 (happy path, corrected gate):                         *)
(*   Edit(idea) -> Enhance -> AgentStart -> AgentEmit(md) ->               *)
(*   AgentEmit(mmd)   [unlocks tla tab; NOT ts]  -> AgentEmit(tla) ->      *)
(*   AgentFinish -> SwitchTab(tla) -> RequestVerify -> VerifyTLA           *)
(*   [verified[tla] = TRUE and unlocked gains ts ATOMICALLY here] ->       *)
(*   AgentStart -> AgentEmit(ts) -> AgentFinish.                           *)
(*   Note: no behavior of this spec reaches ts without VerifyTLA — the     *)
(*   current code's mmd -> ts unlock rule is excluded by construction.     *)
(*                                                                         *)
(* SAMPLE BEHAVIOR 2 (storage failure, no silent loss):                    *)
(*   Edit(md) -> PersistFail [health = degraded, notified = TRUE] ->       *)
(*   Edit(mmd) [mem grows, disk does not] -> Reload [mmd presence lost     *)
(*   from volatile state, but VolatilePresenceAlarmed held throughout]     *)
(*   -> alternative: RecoverStorage resyncs disk := mem before Reload.     *)
(***************************************************************************)

CONSTANTS Stages

ASSUME /\ "idea" \in Stages
       /\ "md"   \in Stages
       /\ "mmd"  \in Stages
       /\ "tla"  \in Stages
       /\ "ts"   \in Stages

VARIABLES cur,            \* volatile: current tab
          unlocked,       \* volatile: set of reachable stages
          completed,      \* volatile: stages the agent has produced
          verified,       \* volatile: stage -> BOOLEAN (TLC-clean)
          art,            \* volatile: stage -> presence BOOLEAN
          curDisk,        \* durable mirror of the five above
          unlockedDisk,
          completedDisk,
          verifiedDisk,
          artDisk,
          agent,          \* "idle" | "running"
          health,         \* storage: "ok" | "degraded"
          notified,       \* user has been shown a persistence alarm
          verifyRequested \* explicit, user-authorized verification request

vars     == <<cur, unlocked, completed, verified, art,
              curDisk, unlockedDisk, completedDisk, verifiedDisk, artDisk,
              agent, health, notified, verifyRequested>>
memVars  == <<cur, unlocked, completed, verified, art>>
diskVars == <<curDisk, unlockedDisk, completedDisk, verifiedDisk, artDisk>>
ctlVars  == <<agent, health, notified, verifyRequested>>

AgentStages == {"md", "mmd", "tla", "ts"}
NoneTrue   == [s \in Stages |-> FALSE]

\* -----------------------------------------------------------------------

TypeOK ==
  /\ cur            \in Stages
  /\ unlocked       \subseteq Stages
  /\ completed      \subseteq Stages
  /\ verified       \in [Stages -> BOOLEAN]
  /\ art            \in [Stages -> BOOLEAN]
  /\ curDisk        \in Stages
  /\ unlockedDisk   \subseteq Stages
  /\ completedDisk  \subseteq Stages
  /\ verifiedDisk   \in [Stages -> BOOLEAN]
  /\ artDisk        \in [Stages -> BOOLEAN]
  /\ agent          \in {"idle", "running"}
  /\ health         \in {"ok", "degraded"}
  /\ notified       \in BOOLEAN
  /\ verifyRequested \in BOOLEAN

Init ==
  /\ cur            = "idea"
  \* Paste-into-early-stage UX: idea/md/mmd are reachable from boot.
  /\ unlocked       = {"idea", "md", "mmd"}
  /\ completed      = {}
  /\ verified       = NoneTrue
  /\ art            = NoneTrue
  /\ curDisk        = "idea"
  /\ unlockedDisk   = {"idea", "md", "mmd"}
  /\ completedDisk  = {}
  /\ verifiedDisk   = NoneTrue
  /\ artDisk        = NoneTrue
  /\ agent          = "idle"
  /\ health         = "ok"
  /\ notified       = FALSE
  /\ verifyRequested = FALSE

(***************************************************************************)
(* SyncDisks — THE persistence contract, stated exactly once.              *)
(* Every volatile mutation below is conjoined with SyncDisks: while        *)
(* storage is healthy the durable mirror is updated in the SAME atomic     *)
(* step (the implementation's synchronous localStorage write in            *)
(* setArtifact/setSession); while degraded, durability pauses — but        *)
(* PersistFail has already set notified, so divergence is never silent.    *)
(* No mutating action is permitted to skip this conjunct.                  *)
(***************************************************************************)
SyncDisks ==
  /\ artDisk'        = IF health = "ok" THEN art'        ELSE artDisk
  /\ curDisk'        = IF health = "ok" THEN cur'        ELSE curDisk
  /\ unlockedDisk'   = IF health = "ok" THEN unlocked'   ELSE unlockedDisk
  /\ completedDisk'  = IF health = "ok" THEN completed'  ELSE completedDisk
  /\ verifiedDisk'   = IF health = "ok" THEN verified'   ELSE verifiedDisk

UnlocksFor(s, v) ==
  \* The unlock rule. Compare the implementation's
  \* AGENT_ARTIFACT_RULES, whose mmd -> ts edge let TS render without any
  \* TLA+ verification. Here mmd unlocks the tla TAB (user may paste and
  \* request verification) but ts is granted ONLY by VerifyTLA — or by a
  \* tla emission when verification already holds.
  CASE s = "md"  -> {"md", "mmd"}
    [] s = "mmd" -> {"mmd", "tla"}
    [] s = "tla" -> IF v["tla"] THEN {"ts"} ELSE {}
    [] s = "ts"  -> {"ts"}
    [] OTHER     -> {}

\* ------------------------- USER ACTIONS -------------------------------

UserEdit(s) ==  \* type/paste into the current tab (or upload)
  /\ s \in unlocked
  /\ cur = s
  /\ art' = [art EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<cur, unlocked, completed, verified>>
  /\ UNCHANGED ctlVars
  /\ SyncDisks

SwitchTab(s) ==
  /\ s \in unlocked
  /\ cur' = s
  /\ UNCHANGED <<unlocked, completed, verified, art>>
  /\ UNCHANGED ctlVars
  /\ SyncDisks
  \* REGRESSION GUARD (by absence): SwitchTab has no verification effect.
  \* The previous design fired SANY+TLC on entering the tla/ts tab, an
  \* unrequested ~652 s run. No successor of SwitchTab enables VerifyTLA.

Enhance ==      \* the copilot enhance contract (finding F6)
  /\ art[cur] = TRUE        \* enhance operates on existing content only
  /\ UNCHANGED memVars      \* PRESENCE PRESERVED: output may transform
                            \* content, and enhance may fail outright,
                            \* but a non-empty artifact never becomes empty.
  /\ UNCHANGED ctlVars
  /\ SyncDisks

RequestVerify == \* explicit authorization — a user gesture on the tla
                 \* tab, or a user-authorized agent run reaching tla
  /\ ~verified["tla"]
  /\ ~verifyRequested
  /\ \/ cur = "tla" /\ art["tla"]
     \/ agent = "running" /\ "tla" \in completed
  /\ verifyRequested' = TRUE
  /\ UNCHANGED memVars
  /\ UNCHANGED <<agent, health, notified>>
  /\ SyncDisks

VerifyTLA ==    \* SANY+TLC succeeds; this is the only action that opens the ts gate
  /\ verifyRequested
  /\ art["tla"]
  /\ ~verified["tla"]
  /\ verified'  = [verified EXCEPT !["tla"] = TRUE]
  /\ unlocked'  = unlocked \cup {"ts"}   \* ts reachable EXACTLY when
                                         \* verification lands — atomically
  /\ verifyRequested' = FALSE
  /\ UNCHANGED <<cur, completed, art>>
  /\ UNCHANGED <<agent, health, notified>>
  /\ SyncDisks

\* ------------------------- AGENT ACTIONS ------------------------------

AgentStart ==    \* user presses Run — itself the explicit authorization
  /\ agent = "idle"
  /\ \E s \in Stages : art[s]
  /\ agent' = "running"
  /\ UNCHANGED memVars
  /\ UNCHANGED <<health, notified, verifyRequested>>
  /\ SyncDisks

AgentEmit(s) ==  \* one pipeline stage completes and ships its artifact
  /\ agent = "running"
  /\ s \in AgentStages
  /\ s \notin completed
  /\ (s = "ts") => ("ts" \in unlocked)   \* the pipeline cannot emit TS
                                         \* before the gate has opened
  /\ completed' = completed \cup {s}
  /\ art'       = [art EXCEPT ![s] = TRUE]
  /\ unlocked'  = unlocked \cup UnlocksFor(s, verified)
  /\ UNCHANGED <<cur, verified>>
  /\ UNCHANGED ctlVars
  /\ SyncDisks

AgentFinish ==
  /\ agent = "running"
  /\ agent' = "idle"
  /\ UNCHANGED memVars
  /\ UNCHANGED <<health, notified, verifyRequested>>
  /\ SyncDisks

\* ----------------------- PERSISTENCE EVENTS ---------------------------

PersistFail ==   \* environment: quota exhausted. ALWAYS surfaced.
  /\ health = "ok"
  /\ health' = "degraded"
  /\ notified' = TRUE          \* the old silent catch{} is unrepresentable
  /\ UNCHANGED memVars
  /\ UNCHANGED diskVars
  /\ UNCHANGED <<agent, verifyRequested>>

Reload ==        \* browser refresh: volatile state is rebuilt from the
                 \* durable mirror; the server-side agent survives and the
                 \* client reattaches, so `agent` is untouched
  /\ art'        = artDisk
  /\ cur'        = curDisk
  /\ unlocked'   = unlockedDisk
  /\ completed'  = completedDisk
  /\ verified'   = verifiedDisk
  /\ UNCHANGED diskVars
  /\ UNCHANGED ctlVars

RecoverStorage == \* trimmed-retry succeeds: durable mirror catches up
  /\ health = "degraded"
  /\ health' = "ok"
  /\ artDisk'        = art
  /\ curDisk'        = cur
  /\ unlockedDisk'   = unlocked
  /\ completedDisk'  = completed
  /\ verifiedDisk'   = verified
  /\ UNCHANGED memVars
  /\ UNCHANGED <<agent, notified, verifyRequested>>

Next ==
  \/ \E s \in Stages      : UserEdit(s)
  \/ \E s \in Stages      : SwitchTab(s)
  \/ Enhance
  \/ RequestVerify
  \/ VerifyTLA
  \/ AgentStart
  \/ \E s \in AgentStages : AgentEmit(s)
  \/ AgentFinish
  \/ PersistFail
  \/ Reload
  \/ RecoverStorage

\* -----------------------------------------------------------------------

(***************************************************************************)
(* SAFETY — the inductive invariant.                                       *)
(*                                                                         *)
(* Inductiveness argument (per-conjunct, over the 11 actions):             *)
(* - Init establishes every conjunct trivially (ts absent, disk = mem,     *)
(*   health ok, notified FALSE with no divergent presence).                *)
(* - SyncSound: disk vars are written only by SyncDisks (under health ok,  *)
(*   from mem values that already satisfy the inclusions) and by           *)
(*   RecoverStorage (which copies mem wholesale); Reload forces mem :=     *)
(*   disk, restoring the inclusions. UserEdit/AgentEmit only ADD presence  *)
(*   and unlocks, so mem sets grow monotonically between Reloads.          *)
(* - TSRequiresVerifiedTLA: the only actions extending unlocked are        *)
(*   AgentEmit (UnlocksFor grants ts only when verified["tla"] already     *)
(*   holds, or for s = ts whose guard requires "ts" \in unlocked, so the   *)
(*   invariant's antecedent pre-holds) and VerifyTLA (which sets           *)
(*   verified["tla"]' = TRUE in the same atomic step it grants ts).        *)
(*   Reload restores the disk pair, guarded by the auxiliary DiskGate.     *)
(* - VolatilePresenceAlarmed: art[s] without artDisk[s] requires a write   *)
(*   under health = degraded, and PersistFail sets notified in the same    *)
(*   step it degrades; Reload clears the antecedent by dropping art[s].    *)
(* - CurSound: cur is only set to stages in unlocked (SwitchTab guard),    *)
(*   and Reload restores curDisk, which DiskCurSound keeps inside          *)
(*   unlockedDisk \subseteq unlocked.                                      *)
(* The auxiliary conjuncts DiskGate, DiskCurSound, VerifiedAlarmed are     *)
(*   strengthening needed for inductiveness, not new requirements.         *)
(***************************************************************************)

CurSound == cur \in unlocked

SyncSound ==  \* the durable mirror is a PREFIX of volatile history:
              \* reload never resurrects what mem forgot, never invents
  /\ unlockedDisk  \subseteq unlocked
  /\ completedDisk \subseteq completed
  /\ \A s \in Stages : artDisk[s]      => art[s]
  /\ \A s \in Stages : verifiedDisk[s] => verified[s]

VolatilePresenceAlarmed ==  \* NO SILENT LOSS: volatile-only presence
                            \* implies the user has been told durability
                            \* is degraded (never silently)
  \A s \in Stages : (art[s] /\ ~artDisk[s]) => notified

VerifiedAlarmed ==          \* same contract for volatile-only verification
  (verified["tla"] /\ ~verifiedDisk["tla"]) => notified

TSRequiresVerifiedTLA ==    \* ts is reachable only after a SANY-verified spec
  ("ts" \in unlocked) => verified["tla"]

VerifySound ==              \* cannot verify what does not exist
  verified["tla"] => art["tla"]

HealthAlarm ==              \* persistence degradation is always surfaced
  (health = "degraded") => notified

DiskGate ==                 \* auxiliary: the gate survives Reload
  ("ts" \in unlockedDisk) => verifiedDisk["tla"]

DiskCurSound ==             \* auxiliary: persisted tab is reachable
  curDisk \in unlockedDisk

Inv ==
  /\ TypeOK
  /\ CurSound
  /\ SyncSound
  /\ VolatilePresenceAlarmed
  /\ VerifiedAlarmed
  /\ TSRequiresVerifiedTLA
  /\ VerifySound
  /\ HealthAlarm
  /\ DiskGate
  /\ DiskCurSound

\* -----------------------------------------------------------------------

(***************************************************************************)
(* LIVENESS — claimed only with the fairness hypotheses that discharge     *)
(* them, preserving machine closure: both WF actions are pure progress     *)
(* (they flip control flags and set verification), so conjoining their     *)
(* WF to Init /\ [][Next]_vars cannot exclude any safe behavior.           *)
(*                                                                         *)
(* Termination: AgentFinish is enabled in every running state, so WF       *)
(* fires — a run cannot hang forever.                                      *)
(* VerifyResponds: if a request is authorized while storage is healthy,    *)
(* the tla artifact is already durable (SyncSound), so neither PersistFail *)
(* nor Reload can disable VerifyTLA permanently; WF fires. The health      *)
(* conjunct in the antecedent is honest: a request issued into degraded    *)
(* storage may be legitimately dropped WITH the user notified.             *)
(***************************************************************************)

Termination   == (agent = "running") ~> (agent = "idle")
VerifyResponds == (verifyRequested /\ art["tla"] /\ health = "ok")
                  ~> verified["tla"]

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(AgentFinish)
  /\ WF_vars(VerifyTLA)

(***************************************************************************)
(* CHECKABILITY ARGUMENT: raw state space ~ (2^5)^4 x (2^5)^4 x 5^2 x 2^4  *)
(* ~ 10^12 assignments, but SyncSound collapses the reachable region:      *)
(* disk equals mem whenever health = ok, and divergent states require      *)
(* PersistFail first. Reachable states are O(10^4) — TLC exhausts this     *)
(* in seconds on one worker; no symmetry reduction or constraint needed.   *)
(* Deadlock is impossible: Reload is always enabled.                       *)
(***************************************************************************)

=============================================================================
