# System Design Progress

## Current state

- Current day: 4
- Current topic: Basic Caching with Cache-Aside
- Track: Foundations
- LLD progress: Foundations, repository and cache interfaces introduced
- HLD progress: Foundations, shared cache read path introduced
- Difficulty: Intermediate foundations
- Previous completed day: 3
- Next suggested concept: TTL and eviction policies

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
- Suggested next concepts: TTL and eviction policies, then cache stampede and invalidation races
