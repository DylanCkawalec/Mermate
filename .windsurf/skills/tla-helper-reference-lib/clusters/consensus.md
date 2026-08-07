# Cluster: Consensus & Agreement

**Purpose for the Leslie agent**: This is the highest-leverage cluster for complex distributed systems work. Consensus is where abstraction decisions, fairness, refinement, and industrial constraints collide most violently. Study these materials when modeling agreement, leader election, log replication, reconfiguration, or Byzantine fault tolerance.

**Challenge questions to ask yourself while reading**:
- What is the precise safety property being protected, and at what grain of atomicity?
- Where does the model deliberately abstract message loss, delay, or process failure?
- How does the refinement chain (if present) move from abstract voting / consensus to a concrete protocol?
- What industrial constraint (reconfiguration, linearizability under crash, partial synchrony) is the most stress-inducing?

## Canonical Lamport & Official Examples (Start Here)

- **PaxosHowToWinATuringAward**  
  https://github.com/tlaplus/Examples/tree/master/specifications/PaxosHowToWinATuringAward  
  The purest refinement teaching example. Abstract Consensus → Voting → Paxos. Study the successive refinement mappings and the invariants that are preserved. This is the gold standard for how to think in layers.

- **Paxos** (classic)  
  https://github.com/tlaplus/Examples/tree/master/specifications/Paxos  
  Direct specification of the Paxos protocol. Compare with the refined version above.

- **byzpaxos (Byzantizing Paxos by Refinement)**  
  https://github.com/tlaplus/Examples/tree/master/specifications/byzpaxos  
  Shows how to obtain Byzantine consensus by refinement from a non-Byzantine model. Extremely instructive for the cost and structure of Byzantine tolerance.

- **MultiPaxos / MultiPaxos-SMR / diskpaxos / SimplifiedFastPaxos / TencentPaxos**  
  All inside the official Examples repository. Useful for seeing variations in leader-based, multi-decree, and disk-based formulations.

## Raft Family

- **Classic Raft TLA+** (Diego Ongaro lineage)  
  https://github.com/ongardie/raft.tla  
  The original formalization that accompanied the Raft paper. Clean decomposition into leader election, log replication, and safety.

- **etcd Raft related work**  
  https://github.com/etcd-io/raft/issues/111 and associated trace-validation efforts.  
  Shows the tension between a production Go implementation and a living TLA+ model, plus runtime refinement checking.

- **Atomix Raft + Client Sequencer**  
  https://github.com/atomix/atomix-tlaplus  
  Includes linearizable client interaction and sequentially consistent streams. Useful when the client-facing contract matters.

## Modern & Byzantine Variants

- **Flexible Paxos**  
  https://github.com/fpaxos/fpaxos-tlaplus

- **Egalitarian Paxos (EPaxos)**  
  https://github.com/efficient/epaxos

- **Tendermint / CometBFT Light Client & Accountability**  
  https://github.com/tendermint/spec (Lightclient and TendermintAcc specs)  
  Strong on safety + fork accountability under partial synchrony.

- **Signal SVR2** (Raft-based with SGX enclaves)  
  https://github.com/signalapp/SecureValueRecovery2/blob/main/docs/svr2.tla  
  Industrial example of consensus inside a confidential-compute boundary.

- **Spire, HotStuff, CBC Casper, Just-in-Time Paxos**  
  Search the awesome-tlaplus real-world list and the Examples repository for current high-quality formalizations. These expose different trade-offs in latency, view-change, and accountability.

## Dr. TLA+ Series (Algorithm + Spec Study)

- https://github.com/tlaplus/DrTLAPlus  
  Contains dedicated sessions on Paxos, Raft, ByzPaxos, TiDB, etc. Each pairs an algorithm explanation with a careful reading of a TLA+ model. Excellent for disciplined comparative study.

## How to use this cluster

1. Begin with PaxosHowToWinATuringAward if the task involves any form of agreement or refinement.
2. Move to a concrete industrial or modern variant only after the abstract safety properties are clear.
3. When the current model feels “too concrete too early,” return to the refinement chain examples.
4. Extract one invariant or one abstraction decision per consultation; do not attempt to internalize an entire protocol in one pass.
