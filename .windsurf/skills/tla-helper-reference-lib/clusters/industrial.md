# Cluster: Industrial Distributed Systems & Databases

**Purpose for the Leslie agent**: Academic examples teach clarity; industrial examples teach survival under real constraints (partial failure, reconfiguration, operational complexity, large state spaces, client contracts). Consult this cluster when the system under study has production characteristics or when pure academic models feel too clean.

**Challenge questions**:
- What operational constraint (reconfiguration, multi-datacenter, power failure, client linearizability) forced additional complexity?
- Which bugs were found by the TLA+ model that testing and code review missed?
- How was the model kept checkable despite industrial scale?
- What change in design thinking resulted from writing the specification?

---

## Primary Industrial Narratives

- **Lamport’s Industrial Use page**  
  https://lamport.azurewebsites.net/tla/industrial-use.html  
  The authoritative collection of outcomes. Always orient here first.

- **“How Amazon Web Services Uses Formal Methods” (CACM 2015 / Newcombe et al.)**  
  https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf  
  The single most important industrial experience report.

---

## Specific Industrial Case Studies

### Amazon Web Services (AWS)

**DynamoDB Replication & Fault Tolerance** (T.R. / Chris Newcombe lineage)
- Modeled the core replication and fault-tolerance mechanisms.
- TLC (distributed on a 10-machine EC2 cluster) found a subtle data-loss bug whose shortest error trace required **35 high-level steps**.
- The bug had survived extensive design reviews, code reviews, and fault-injection testing.
- Additional bugs were found in related algorithms; all were fixed and re-verified.
- Later, when adding cross-data-center migration, the existing specification immediately revealed a new subtle design bug that was fixed before implementation.
- Key lesson: informal proofs and heavy testing are insufficient for this class of subtle interleavings.

**S3**
- Multiple components modeled in PlusCal (fault handling ~804 LOC, background processes ~645 LOC).
- Found multiple bugs, including further issues discovered during continued use of the models.

**EBS (Elastic Block Store) Volume Management**
- ~102 LOC PlusCal model.
- Found 3 bugs.

**Other AWS internal systems**
- Lock managers, fault-tolerant replication algorithms, and low-level network algorithms were modeled; bugs were found and proposed optimizations were verified or refuted.

### Microsoft Azure / Cosmos DB

- Client-centric TLA+ specifications of the five consistency models offered by Cosmos DB (strong, bounded staleness, session, consistent prefix, eventual).
- Specifications used both for internal design validation and for clarifying public documentation.
- A concise (~390 LOC) client-focused specification helped identify documentation bugs that were subsequently corrected.
- The same line of work produced a mechanized explanation of a high-severity, 28-day Azure outage whose root cause had been difficult to isolate by conventional means.
- Additional Azure Networking work (DNS record propagation, RingMaster global replication & checkpoint coordination, Distributed Load Shedding, Macsec key rollover) found design-level bugs, including intermittent unit-test failures whose root cause was a logical design error.

### Intel

- Cache-coherence protocol for a new processor.
- Pre-RTL formal verification with TLA+.
- Hundreds of bugs found before RTL; 45 issues filed; the verified areas later showed the lowest bug ratio per line of RTL and essentially no coherence-protocol bugs on silicon.

### Elasticsearch

- Formal models of core replication and replica engine behavior:  
  https://github.com/elastic/elasticsearch-formal-models
- Used to understand and verify consistency properties of a large-scale search and analytics engine.

### Kafka

- TLA+ specification of the ISR-based replication protocol (including related KIPs).
- Model checking revealed multiple edge cases that could lead to data loss; some were previously unknown.
- Fixes were validated with the model; one subtle bug in an initial proposed fix was also caught.

### MongoDB

- Replication protocol models with trace-checking against the real system:  
  https://github.com/visualzhou/mongo-repl-tla

### Other Notable Industrial / Near-Industrial Cases

- **Signal SVR2**: Raft-based consensus inside SGX enclaves with self-healing (open specification available).
- **TiDB / PingCAP**: Raft + distributed transactions (open models).
- **etcd Raft**: Ongoing work on TLA+ specifications + runtime trace validation / refinement checking.
- **Dropbox**: Two-phase commit and distributed deadlock detection; bugs found and fixed with model-checker confirmation.
- **Servo (browser engine)**: Concurrency bugs in the event loop found and fixed with TLA+ help.

---

## Open High-Value Specifications (for direct study)

- Elasticsearch: https://github.com/elastic/elasticsearch-formal-models
- TiDB: https://github.com/pingcap/tla-plus
- MongoDB replication: https://github.com/visualzhou/mongo-repl-tla
- Kafka replication: https://github.com/hachikuji/kafka-specification
- Signal SVR2: https://github.com/signalapp/SecureValueRecovery2/blob/main/docs/svr2.tla
- etcd-related: https://github.com/etcd-io/raft/issues/111 and associated papers
- Additional models (BookKeeper, Ceph, Xen vchan, Linux kernel primitives, Ubisoft queues, etc.): see the real-world section of https://github.com/tlaplus/awesome-tlaplus

---

## How to use this cluster

1. Begin with the AWS CACM paper and Lamport’s industrial-use page when you need evidence of real impact.
2. Move to a concrete open specification (Elasticsearch, TiDB, Signal, etc.) when you need to study modeling style under industrial constraints.
3. Extract **one** concrete lesson per consultation — usually a bug class, an abstraction decision forced by operational reality, or a statement about what testing missed.
4. Return immediately to the current specification task; do not attempt to internalize an entire industrial system model in one sitting.

These case studies exist to keep the agent honest about the difference between a clean academic model and a model that must survive production.
