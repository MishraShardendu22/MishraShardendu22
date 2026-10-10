# System Design Progress

## Current state

- Current day: 5
- Current topic: TTL and Eviction Policies
- Track: Foundations
- LLD progress: Foundations, cache adapter policy/configuration
- HLD progress: Foundations, cache freshness and memory-pressure behavior
- Difficulty: Intermediate foundations
- Previous completed day: 4
- Next suggested concept: Cache stampede and invalidation races

## Day 1

- Topic: Requirements, constraints, latency, throughput, availability, reliability, capacity estimation
- Classification: HLD foundation
- Concepts introduced: requirements analysis, SLO-oriented thinking, traffic/capacity estimation
- Concepts reinforced: none
- Prerequisites satisfied: baseline system-design reasoning

## Day 2

- Topic: API Design
- Classification: LLD + HLD foundation
- Concepts introduced: resource-oriented contracts, HTTP method semantics, request/response schemas, validation, error contracts, pagination, idempotency, versioning, compatibility
- Concepts reinforced: requirements and constraints, latency/throughput thinking
- Prerequisites satisfied: requirements analysis and capacity estimation

## Day 3

- Topic: Data Modeling
- Classification: HLD foundation + LLD persistence-boundary design
- Concepts introduced: access-pattern-driven modeling, invariants, normalization, denormalization, primary keys, composite indexes, cursor-friendly ordering, domain-specific repository operations
- Concepts reinforced: API contracts, pagination, latency, throughput, consistency boundaries
- Prerequisites satisfied: requirements analysis, capacity estimation, API design

## Day 4

- Topic: Basic Caching with Cache-Aside
- Classification: HLD foundation + LLD integration pattern
- Concepts introduced: cache-aside, cache hit/miss paths, lazy population, cache invalidation, cache as derived state, cache-failure fallback
- Concepts reinforced: API access patterns, database as source of truth, TTL as a bounded-residence mechanism, read/write consistency
- Prerequisites satisfied: requirements and capacity estimation, API design, data modeling and access patterns

## Day 5

- Topic: TTL and Eviction Policies
- Classification: HLD caching policy + LLD cache adapter configuration
- Concepts introduced: TTL semantics, expiration, eviction, LRU, LFU, allkeys versus volatile policies, memory headroom, TTL jitter
- Concepts reinforced: cache-aside, invalidation, cache as disposable derived state, database fallback
- Prerequisites satisfied: requirements/capacity estimation, API design, data modeling, cache-aside
- Suggested next concepts: cache stampede and invalidation races
