# DAY 3: Data Modeling

## 1. Why this concept exists

Once an API defines resources and operations, the system needs a durable representation of those resources.

The database schema determines which queries are cheap, which invariants are enforceable, how data grows, how concurrent updates behave, and how difficult future changes become.

The production problem is:

> Given the operations the system must support, what representation makes those operations correct, efficient, and evolvable at the expected scale?

A schema designed without access patterns often looks clean initially and becomes expensive later. Data modeling therefore sits between API semantics and storage-engine behavior.

## 2. Core idea

Model around invariants and access patterns, not around objects alone.

For every important entity, identify:

1. Identity.
2. Invariants.
3. Relationships.
4. Dominant reads.
5. Dominant writes.
6. Expected cardinality and growth.
7. Latency-sensitive queries.
8. Derived versus authoritative data.
9. Required consistency.
10. Indexes justified by actual query patterns.

A useful workflow is:

~~~text
Requirements -> API operations -> Access patterns -> Logical model -> Physical schema -> Indexes
~~~

For the Day 2 task API:

~~~text
POST /v1/tasks
GET /v1/tasks/{id}
GET /v1/tasks?status=queued&limit=100&cursor=...
~~~

the storage model should support lookup by ID, filtering by status, stable ordering for pagination, efficient creation, and concurrency-safe state transitions.

Example:

~~~text
tasks
-----
id            PK
name
priority
status
created_at
updated_at
~~~

with:

~~~sql
CREATE INDEX tasks_status_created_at_idx
ON tasks (status, created_at, id);
~~~

The index is justified by the concrete query pattern, not because status happens to be a column.

PostgreSQL documents that multicolumn B-tree indexes are most effective when constraints use the leading columns, so index column order must follow actual predicates and ordering requirements. citeturn0search1

### Normalize first, denormalize deliberately

Normalization reduces duplicated facts and makes invariants easier to maintain.

~~~text
users
-----
id
email

tasks
-----
id
user_id
name
status
~~~

is usually preferable to copying authoritative user data into every task.

Denormalization becomes reasonable when read performance, locality, or workload shape justifies duplicated state:

~~~text
feed_entries
------------
user_id
post_id
author_name
post_preview
created_at
~~~

Now reads may be cheaper, but synchronization and consistency become part of the design.

The right question is:

> Which invariants and read/write costs am I choosing to preserve or sacrifice?

### Relational versus key-value modeling

A relational database is useful when the system needs transactions across related records, strong integrity constraints, rich predicates, joins, or flexible query composition.

A key-value or wide-column system becomes attractive when access patterns are known and predictable, especially when partitioning and horizontal scale dominate.

AWS documents DynamoDB's partition-key and optional sort-key model and recommends high-cardinality partition keys to reduce hot partitions. This illustrates a different modeling philosophy where access patterns and partition distribution are part of the primary data model. citeturn0search12

## 3. Mental model

Think of a schema as a compiled representation of your workload.

The API says what clients need.

The access pattern says how the system retrieves or mutates it.

The schema and indexes say how the storage engine makes that workload cheap and correct.

A table definition without its important queries is incomplete system design.

Ask:

> Show me the five most important queries and the invariants they depend on.

If you cannot answer that, the schema is probably being designed too abstractly.

## 4. Real-world example

### Publicly documented: PostgreSQL

PostgreSQL documents several index types and their intended workloads. B-tree indexes support equality and range-oriented comparisons, while other index types target different predicate classes. PostgreSQL also notes that indexes add system overhead and should be used sensibly. citeturn0search3turn0search11

PostgreSQL also automatically creates the required unique-index machinery for primary keys and unique constraints. citeturn0search8

### Publicly documented: DynamoDB

AWS documents partition keys, sort keys, secondary indexes, and the importance of high-cardinality partition keys for avoiding access imbalance and hot partitions. citeturn0search12

### Industry-standard inference

For any database:

- Model around dominant access patterns.
- Make invariants enforceable by the storage layer where practical.
- Design indexes from query predicates and ordering.
- Treat every index as additional write, storage, and maintenance cost.
- Revisit the model when workload shape changes.

## 5. LLD

Separate domain entities from persistence representation.

~~~text
Task
 |
 +-- ID
 +-- Name
 +-- Priority
 +-- Status
 +-- CreatedAt
 +-- UpdatedAt

TaskService
 |
 v
TaskRepository
 |
 v
PostgreSQL
~~~

A useful repository boundary is:

~~~go
type TaskRepository interface {
    Create(ctx context.Context, task *Task) error
    Get(ctx context.Context, id string) (*Task, error)
    ListByStatus(ctx context.Context, status string, limit int, cursor time.Time) ([]Task, error)
    TransitionStatus(ctx context.Context, id string, from, to string) error
}
~~~

The important method is TransitionStatus.

Instead of reading a task, modifying it, and writing it back:

~~~go
task, _ := repo.Get(...)
task.Status = "running"
repo.Update(...)
~~~

the repository can express the invariant atomically:

~~~sql
UPDATE tasks
SET status = 'running', updated_at = now()
WHERE id = $1 AND status = 'queued';
~~~

The affected-row count tells the caller whether the transition actually happened.

Do not create a generic Update(Task) method if different fields have different invariants. Domain-specific operations expose meaningful consistency boundaries.

## 6. HLD

At system level, data modeling determines storage behavior under load.

~~~text
                  +----------------+
                  |  API Instances  |
                  +--------+-------+
                           |
                           v
                    +-------------+
                    | Task Service|
                    +------+------+
                           |
                           v
                 +-------------------+
                 | PostgreSQL Primary|
                 +---------+---------+
                           |
                  +--------+--------+
                  |                 |
                  v                 v
          Read Replica(s)       Backup/Object
                                Storage
~~~

The primary handles authoritative writes.

Read replicas can absorb suitable read traffic, but introduce replica lag. An API requiring read-after-write behavior must account for that.

Example schema:

~~~sql
CREATE TABLE tasks (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    priority    integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
    status      text NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);

CREATE INDEX tasks_status_created_at_id_idx
ON tasks (status, created_at, id);
~~~

A cursor-friendly query:

~~~sql
SELECT id, name, priority, status, created_at, updated_at
FROM tasks
WHERE status = $1
  AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4;
~~~

The pair (created_at, id) provides deterministic ordering when timestamps collide.

At larger scale, this model eventually raises replication, partitioning, sharding, hot-key, archival, index-size, backup, and storage-growth questions. Those are later concepts. The prerequisite is an explicit logical model and workload.

## 7. Code

The following Go repository uses database/sql and PostgreSQL-style placeholders. It makes persistence operations correspond to explicit access patterns and invariants.

~~~go
package taskstore

import (
    "context"
    "database/sql"
    "errors"
    "time"
)

var (
    ErrNotFound = errors.New("task not found")
    ErrInvalidState = errors.New("invalid state transition")
)

type Task struct {
    ID        string
    Name      string
    Priority  int
    Status    string
    CreatedAt time.Time
    UpdatedAt time.Time
}

type Repository struct {
    db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
    return &Repository{db: db}
}

func (r *Repository) Create(ctx context.Context, task *Task) error {
    const query = "INSERT INTO tasks (id, name, priority, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)"

    _, err := r.db.ExecContext(
        ctx,
        query,
        task.ID,
        task.Name,
        task.Priority,
        task.Status,
        task.CreatedAt,
        task.UpdatedAt,
    )

    return err
}

func (r *Repository) Get(ctx context.Context, id string) (*Task, error) {
    const query = "SELECT id, name, priority, status, created_at, updated_at FROM tasks WHERE id = $1"

    var task Task

    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &task.ID,
        &task.Name,
        &task.Priority,
        &task.Status,
        &task.CreatedAt,
        &task.UpdatedAt,
    )
    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, err
    }

    return &task, nil
}

func (r *Repository) ListByStatus(
    ctx context.Context,
    status string,
    after time.Time,
    afterID string,
    limit int,
) ([]Task, error) {
    const query = "SELECT id, name, priority, status, created_at, updated_at FROM tasks WHERE status = $1 AND (created_at, id) > ($2, $3) ORDER BY created_at ASC, id ASC LIMIT $4"

    rows, err := r.db.QueryContext(
        ctx,
        query,
        status,
        after,
        afterID,
        limit,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    tasks := make([]Task, 0, limit)

    for rows.Next() {
        var task Task

        if err := rows.Scan(
            &task.ID,
            &task.Name,
            &task.Priority,
            &task.Status,
            &task.CreatedAt,
            &task.UpdatedAt,
        ); err != nil {
            return nil, err
        }

        tasks = append(tasks, task)
    }

    if err := rows.Err(); err != nil {
        return nil, err
    }

    return tasks, nil
}

func (r *Repository) TransitionStatus(
    ctx context.Context,
    id string,
    from string,
    to string,
) error {
    const query = "UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND status = $3"

    result, err := r.db.ExecContext(ctx, query, to, id, from)
    if err != nil {
        return err
    }

    affected, err := result.RowsAffected()
    if err != nil {
        return err
    }

    if affected == 0 {
        return ErrInvalidState
    }

    return nil
}
~~~

Schema:

~~~sql
CREATE TABLE tasks (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    priority    integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
    status      text NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);

CREATE INDEX tasks_status_created_at_id_idx
ON tasks (status, created_at, id);
~~~

The important mapping is:

~~~text
API operation
    |
    v
Domain operation
    |
    v
Repository method
    |
    v
Query + constraint + index
~~~

## 8. Example usage

~~~go
task := &Task{
    ID:        "tsk_123",
    Name:      "rebuild-index",
    Priority:  80,
    Status:    "queued",
    CreatedAt: time.Now().UTC(),
    UpdatedAt: time.Now().UTC(),
}

if err := repo.Create(ctx, task); err != nil {
    return err
}

if err := repo.TransitionStatus(
    ctx,
    task.ID,
    "queued",
    "running",
); err != nil {
    return err
}
~~~

For listing:

~~~go
tasks, err := repo.ListByStatus(
    ctx,
    "queued",
    cursorTime,
    cursorID,
    100,
)
if err != nil {
    return err
}
~~~

The caller does not need to know the physical index. The repository contract expresses the access pattern.

## 9. Production considerations

Correctness: put invariants in database constraints when the database can enforce them. Application validation improves error quality but should not be the only protection against concurrent writes.

Indexes: every index consumes storage and increases write amplification. PostgreSQL explicitly notes that indexes add overhead and should be used sensibly. citeturn0search11

Composite indexes: column order matters. For B-tree indexes, leading columns strongly influence how much of the index can be narrowed during a scan. citeturn0search1

Pagination: use a stable ordering key. A timestamp alone can produce duplicates or omissions when records share timestamps. Add a unique tie-breaker such as id.

Hotspots: a logically correct model can still produce pathological load if many writes target the same key or partition.

Read consistency: replicas improve read scalability but can return stale data. APIs requiring read-after-write semantics must account for this.

Schema evolution: migrations should be backward compatible during rolling deployments. Prefer expand-and-contract migrations over destructive changes.

Data lifecycle: model retention, archival, deletion, and TTL requirements early.

Observability: track query latency, rows scanned versus returned, index usage, connection-pool saturation, lock waits, deadlocks, replication lag, and storage growth.

## 10. Design tradeoffs

Normalization vs denormalization: normalization reduces duplication and makes consistency easier. Denormalization can reduce joins and improve read latency, but introduces duplicated state and synchronization cost.

Surrogate key vs natural key: surrogate IDs decouple storage identity from mutable business attributes. Natural keys can enforce business uniqueness directly but become painful when business identifiers change.

Single-column vs composite indexes: single-column indexes are simpler. Composite indexes can precisely support common predicates and ordering but consume more storage and add write cost.

Generic CRUD repository vs domain-specific repository: generic CRUD reduces initial code but can hide important invariants. Domain-specific operations such as TransitionStatus expose meaningful consistency boundaries.

SQL vs NoSQL: SQL systems provide strong relational semantics and rich constraints. NoSQL systems can provide simpler horizontal scaling for specific access patterns. Neither choice is intrinsically more scalable without considering workload shape.

Do not denormalize before identifying a real bottleneck or access-pattern requirement. Do not add an index because a column might be queried someday.

## 11. Connection to previous lessons

Day 2 established API resources and operations.

Today those operations become storage access patterns:

~~~text
POST /tasks
    |
    v
INSERT task

GET /tasks/{id}
    |
    v
PRIMARY KEY lookup

GET /tasks?status=queued&cursor=...
    |
    v
(status, created_at, id) index
~~~

Day 1's throughput and latency constraints now become concrete storage requirements.

If the API requires 100 ms p95 latency, a query scanning millions of rows is immediately suspect. If throughput is high, every unnecessary index creates additional write cost. If availability matters, replication and failover become relevant later.

The dependency is:

Requirements -> API -> Access Patterns -> Data Model -> Indexing

## 12. What comes next

Basic caching is next.

Once the persistent model is correct, the next question is which reads should avoid hitting the primary database on every request.

Caching will build directly on today's access-pattern reasoning:

Query -> Database cost -> Cache candidate -> Consistency/eviction policy

## Key Takeaways

- A database schema represents workload, invariants, and relationships, not just application structs.
- Start from API operations and derive concrete access patterns.
- Put correctness constraints close to authoritative data.
- Design indexes from actual predicates and ordering requirements.
- Composite index column order matters.
- Every index improves some reads while increasing storage and write cost.
- Denormalization is a deliberate consistency tradeoff, not a default optimization.

## Concept Map

~~~text
Day 1
Requirements + Capacity
        |
        v
Day 2
API Design
        |
        v
Access Patterns
        |
        v
Day 3
Data Modeling
   |       |
   |       +----> Constraints
   |       |
   |       +----> Indexes
   |       |
   |       +----> Pagination
   |
   +----> Future: Replication / Sharding

Data Model
    |
    v
Day 4
Caching
    |
    +----> Cache-aside
    +----> TTL
    +----> Eviction
    +----> Stampede
~~~

## Exercise

Design the persistent model for the job-submission API from Day 2.

The system must support:

1. Submit a job with an idempotency key.
2. Retrieve a job by ID.
3. List jobs for one user, newest first.
4. List queued jobs for workers.
5. Atomically transition a job from queued to running.
6. Prevent duplicate submission for the same user and idempotency key.
7. Support cursor pagination.
8. Assume 100 million jobs and a peak of 20,000 job submissions per second.

Deliver:

- Logical entities.
- SQL schema.
- Required constraints.
- Query patterns.
- Indexes and their column order.
- One paragraph explaining which access pattern would become the first bottleneck as the system scales.

Do not introduce caching, sharding, or a queue yet. Keep the exercise focused on data modeling.

## Progress

Added as Day 3 in the dedicated system-design learning journal.

- Classification: HLD foundation with LLD persistence-boundary design.
- Concepts introduced: access-pattern-driven modeling, invariants, normalization, denormalization, primary keys, composite indexes, cursor-friendly ordering, domain-specific repository operations.
- Concepts reinforced: API contracts, pagination, latency, throughput, consistency boundaries.
- Prerequisites satisfied: requirements analysis, capacity estimation, API design.
- Suggested next concept: basic caching, specifically cache-aside and its consistency tradeoffs.

## Most Important Mental Model

A schema is a compiled representation of your workload, so design it from the queries and invariants the system must sustain, not from the shape of your objects alone.
