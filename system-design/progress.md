# System Design Progress

## Current state

- Current day: 3
- Current topic: Data Modeling
- Track: Foundations
- LLD progress: Foundations
- HLD progress: Foundations
- Difficulty: Intermediate foundations
- Previous completed day: 2
- Next suggested concept: Basic Caching, cache-aside

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
- Suggested next concepts: data modeling, then caching and queues

## Day 3

- Topic: Data Modeling
- Classification: HLD foundation + LLD persistence-boundary design
- Concepts introduced: access-pattern-driven modeling, invariants, normalization, denormalization, primary keys, composite indexes, cursor-friendly ordering, domain-specific repository operations
- Concepts reinforced: API contracts, pagination, latency, throughput, consistency boundaries
- Prerequisites satisfied: requirements analysis, capacity estimation, API design
- Suggested next concepts: basic caching, cache-aside, TTL, eviction, cache consistency
