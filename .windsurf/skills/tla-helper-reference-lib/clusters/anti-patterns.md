# Cluster: Anti-Patterns & Lessons Learned

**Purpose for the Leslie agent**: The most valuable external knowledge is often negative knowledge — what fails, what looks plausible but is wrong, and what industrial practitioners repeatedly rediscover the hard way. This cluster exists to keep those lessons immediately accessible so they can interrupt bad modeling decisions early.

**Challenge questions**:
- Am I treating TLA+ as a programming language rather than a description of allowed behaviors?
- Have I skipped the sample-behavior step?
- Is my invariant trivial or tied to implementation detail rather than the property of interest?
- Am I modeling at too fine a grain of atomicity without justification?
- Does the current model introduce behaviors that the abstract safety property should have forbidden?

## Primary Sources of Negative Knowledge

- **AWS Formal Methods Experience (2015 CACM and follow-ups)**  
  Linked from https://lamport.azurewebsites.net/tla/industrial-use.html  
  The strongest published industrial statement of what formal methods catch that testing and code review miss, and of the change in design thinking that results.

- **Microsoft Azure / Cosmos DB case studies**  
  Same industrial-use page and related reports. Concrete examples of safety violations found before coding, under power failure, and in lock-free structures.

- **Hillel Wayne – Practical TLA+ and related writing**  
  Discussions of common modeling mistakes, over-specification, temporal property errors, and the difference between a model that type-checks and a model that actually protects the intended properties.

- **Murat Demirbas writings**  
  Multi-grained specifications, TLA+ as design accelerator, and the practical difficulties of keeping models faithful to evolving systems.

## Anti-Patterns Explicitly Reinforced by External Evidence

These are already stated in the master agent; this cluster supplies the external corroboration:

1. Skipping the writing of concrete sample behaviors before choosing variables.
2. Choosing a grain of atomicity that is either too fine (state space explosion) or too coarse (hides the errors of interest) without explicit justification.
3. Writing invariants that are true of the model but do not capture the safety property the system must actually guarantee.
4. Treating TLA+ operators and actions as if they were executable code.
5. Missing or incorrect UNCHANGED clauses and priming errors.
6. Adding fairness conditions that destroy machine closure or that are stronger than necessary.
7. Jumping to a concrete protocol model without first writing (and checking) a simple abstract specification that the protocol is supposed to refine.
8. Failing to hide internal variables that are not part of the external interface.

## How to use this cluster

Consult it at two moments:
- Early, when the first modeling decisions are being made (to avoid classic traps).
- Late, when a model is “almost working” but the invariants feel weak or the state space is pathological (to diagnose the underlying methodological error).

One clear anti-pattern insight per consultation is enough. The goal is interruption of error, not encyclopedic knowledge of failure modes.
