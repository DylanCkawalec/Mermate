# Cluster: Refinement & Successive Abstraction

**Purpose for the Leslie agent**: Refinement is the primary intellectual tool for managing complexity. A good specification is almost always the result of successive refinement from a high-level safety/liveness property down to a more concrete algorithm. This cluster exists to keep that discipline alive and to supply concrete examples of how it is done well (and where it fails).

**Challenge questions**:
- What is the abstract specification that the concrete one is supposed to implement?
- Is the refinement mapping explicit and checkable?
- What state is being hidden, and is the hiding justified by the properties of interest?
- Does the lower-level model introduce new behaviors that escape the abstract safety property?

## Primary Teaching Examples (Mandatory Study)

- **PaxosHowToWinATuringAward**  
  https://github.com/tlaplus/Examples/tree/master/specifications/PaxosHowToWinATuringAward  
  The clearest published demonstration of successive refinement in TLA+. Abstract Consensus → Voting → Paxos. Study the refinement mappings and the invariants that survive each step. This is the reference model for how to think in layers.

- **byzpaxos – Byzantizing Paxos by Refinement**  
  https://github.com/tlaplus/Examples/tree/master/specifications/byzpaxos  
  Shows how Byzantine consensus can be obtained by refining a non-Byzantine model. Illuminates both the power and the cost of the Byzantine case.

## Multi-Grained and Industrial Refinement Thinking

- Murat Demirbas – Multi-Grained Specifications  
  https://muratbuffalo.blogspot.com/2025/04/multi-grained-specifications-for.html  
  Explicit discussion of combining high-level protocol models with finer-grained implementation details. Directly relevant when an industrial system cannot be captured at a single abstraction level.

- “A Tale of Two Refinements” and related LLM-assisted refinement experiments  
  (see awesome-tlaplus entries). Useful for seeing modern attempts to keep refinement discipline while generating implementations.

## Additional Refinement-Relevant Material inside Official Examples

- Peterson Lock with Auxiliary Variables  
- Barrier Synchronization  
- Various mutual-exclusion and locking refinements  
- Transaction Commit models  

These show refinement and auxiliary-variable techniques on smaller, more tractable problems before scaling to consensus.

## Methodological Discipline

When using this cluster:

1. Always identify the abstract specification first.
2. Write the refinement mapping (even if only informally at first).
3. Check that every behavior of the lower-level model projects to a behavior of the higher-level model.
4. Prefer fewer, clearer refinement steps over a single giant leap from abstract property to full protocol.
5. If the current model cannot be shown to refine a simple abstract specification, the abstraction is probably wrong or the model is over-concrete.

Return to this cluster whenever the state space becomes unmanageable or the invariants feel implementation-tied rather than property-driven.
