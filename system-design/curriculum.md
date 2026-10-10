# System Design Curriculum

This curriculum is dependency-driven. The repository is the source of truth for completed lessons.

## Current track

- Day 1: Foundations, completed
- Day 2: API Design, completed
- Day 3: Data Modeling, completed
- Day 4: Basic Caching with Cache-Aside, completed
- Day 5: TTL and Eviction Policies, current
- Next: Cache stampede and invalidation races

## Progression

### Foundations

1. Requirements and constraints
2. Functional vs non-functional requirements
3. Latency, throughput, availability, durability, consistency
4. Capacity estimation and back-of-the-envelope calculations
5. API design
6. Data modeling
7. Basic caching, cache-aside
8. TTL and eviction policies
9. Cache stampede and invalidation races
10. Basic queues
11. Load balancing
12. Stateless services
13. Horizontal vs vertical scaling
14. Database fundamentals for system design

### LLD Foundations

Classes and responsibilities, composition vs inheritance, interfaces, dependency inversion, encapsulation, SOLID, Strategy, Factory, Builder, Adapter, Decorator, Observer, Command, State, Chain of Responsibility, Template Method, Repository, Dependency Injection, event-driven object design.

### LLD Advanced

Thread-safe designs, concurrent data structures, connection pools, rate limiters, retry mechanisms, circuit breakers, schedulers, worker pools, job executors, in-memory caches, pub/sub abstractions, plugin architectures, distributed coordination, idempotency, backpressure, failure handling, concurrency control, resource management.

### HLD Foundations

Reverse proxies, load balancers, caching layers, CDNs, message queues, pub/sub, databases, replication, sharding, partitioning, consistent hashing, object storage, search systems, rate limiting, asynchronous processing, event-driven architecture.

### HLD Advanced

Distributed systems, CAP tradeoffs, consistency models, leader election, consensus, distributed locks, distributed transactions, Saga, event sourcing, CQRS, stream processing, idempotent distributed workflows, delivery semantics, backpressure, failure detection, multi-region architectures, disaster recovery, active-active and active-passive systems, global routing, distributed caching, large-scale storage, data pipelines, observability, multi-tenancy, security architecture, reliability engineering.

### Very Advanced Systems

URL shortener, rate limiter, notification system, API gateway, distributed task scheduler, job queue, chat, file storage, object storage, search engine, logging, metrics, distributed cache, social feed, timeline, video streaming, ride sharing, payments, ad serving, recommendations, real-time analytics, feature flags, workflow orchestration, distributed database, cloud control plane, AI inference platform, LLM gateway, RAG platform, agent execution platform, model-serving infrastructure.

## Dependency policy

The sequence adapts to prerequisites. Related concepts are grouped into chains rather than taught as isolated interview patterns. Revisions must add meaningful depth rather than repeat the earlier explanation.
