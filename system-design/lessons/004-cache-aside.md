# DAY 4: Basic Caching with Cache-Aside

## 1. Why this concept exists

A database is optimized for durable, authoritative state, not necessarily for serving the same hot record thousands of times per second. Repeating a lookup adds network round trips, query execution, connection-pool occupancy, and storage-engine work.

Caching keeps a reconstructible copy of frequently read data closer to the request path. The objective is to reduce expensive origin work while defining what happens when cached data is missing, stale, or unavailable.

Cache-aside is a useful starting point because the application explicitly controls cache reads, population, and invalidation. The cache remains an optimization, not the source of truth.

## 2. Core idea

Cache-aside, also called lazy loading, follows this flow:

~~~text
READ
Service -> Cache
             | hit: return cached value
             | miss
             v
           Database
             |
             v
         Populate cache
             |
             v
          Return value

WRITE
Service -> Database commit -> Invalidate cache key
~~~

For a read:

1. Derive a deterministic cache key from resource identity and representation.
2. Read the cache.
3. On a hit, validate and return the cached representation.
4. On a miss, read the authoritative database.
5. Populate the cache with a bounded lifetime.
6. Return the database result even if cache population fails.

For a write, commit the authoritative database mutation first, then invalidate the affected key. The next read repopulates it from the database.

Example key: user:v1:12345. The versioned namespace makes representation changes easier to manage. Keys must include every dimension that changes the returned representation, such as tenant or locale when applicable.

Deleting a key is often simpler than maintaining a second copy in sync. It is not perfectly consistent, however. A concurrent reader can load an old database value, pause, and populate the cache after a writer has committed and invalidated the key. That stale-repopulation race is real.

A cache miss is normal. A cache outage is an infrastructure failure. Bypassing an unhealthy cache can overload the database unless fallback load is controlled.

## 3. Mental model

Treat the cache as a disposable, derived copy of authoritative data.

The database answers, "What is the committed value?" The cache answers, "Do I already have a usable copy?"

The cache must be safe to lose and rebuild. If deleting the entire cache makes the system incorrect rather than slower, the cache has become an accidental source of truth.

## 4. Real-world example

### Publicly documented

Redis documents cache-aside as checking Redis, reading the primary store on a miss, populating Redis, and invalidating the cache after successful writes. Its Go example also discusses TTL and stampede mitigation: https://redis.io/docs/latest/develop/use-cases/cache-aside/go/

AWS describes lazy caching as loading an object only when requested, then populating the cache after a miss. AWS also documents write-through as a different pattern that proactively updates the cache after a database write: https://aws.amazon.com/caching/best-practices/

### Industry-standard inference

For a read-heavy service with a hot working set, cache-aside can reduce origin database load and improve read latency. The benefit depends on hit rate, payload size, network topology, serialization cost, and cache availability. Measure the complete request path rather than assuming a cache is beneficial.

## 5. LLD

The application service owns the cache-aside policy. The cache adapter owns cache-specific commands. The repository owns authoritative persistence.

~~~text
UserHandler
    |
    v
UserService
    |          |
    v          v
Cache       UserRepository
(Redis)     (SQL database)
~~~

Useful interfaces:

~~~go
type Cache interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

type UserRepository interface {
    GetByID(ctx context.Context, id string) (*User, error)
    Update(ctx context.Context, user *User) error
}
~~~

These interfaces let the policy be tested independently of Redis and isolate the authoritative store. Do not build a generic caching framework before multiple concrete use cases justify it.

## 6. HLD

~~~text
                 +------------------+
Clients -------->| Load Balancer    |
                 +--------+---------+
                          |
                +---------+---------+
                |                   |
                v                   v
          +-----------+       +-----------+
          | API Node 1|       | API Node N|
          +-----+-----+       +-----+-----+
                |                   |
                +---------+---------+
                          |
                          v
                   +-------------+
                   | Redis Cache |
                   +------+------+
                          |
                     cache miss
                          |
                          v
                  +---------------+
                  | Primary DB    |
                  +---------------+
~~~

A shared cache lets API instances reuse entries populated by other instances, but adds a network dependency.

- Hits avoid database queries and reduce database connection occupancy.
- Misses pay for cache lookup, database retrieval, and cache population.
- Finite memory means working-set size and eviction behavior affect hit rate.
- Cache failure can shift read load to the database.
- A popular key expiring under concurrency can cause a stampede.
- Invalidating one record is easy; invalidating all cached query results affected by a mutation is harder.

Cache-aside suits reconstructible data with understood staleness tolerance.

## 7. Code

This Go implementation uses Redis for the cache and database/sql for authoritative persistence. It demonstrates TTL-bounded entries, cache miss handling, best-effort population, database-first writes, and explicit cache error handling.

Dependency:

~~~bash
go get github.com/redis/go-redis/v9
~~~

~~~go
package cacheaside

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrCacheMiss = errors.New("cache miss")
    ErrUserNotFound = errors.New("user not found")
)

type User struct {
    ID        string    `json:"id"`
    Name      string    `json:"name"`
    Email     string    `json:"email"`
    UpdatedAt time.Time `json:"updated_at"`
}

type Cache interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

type UserRepository interface {
    GetByID(ctx context.Context, id string) (*User, error)
    Update(ctx context.Context, user *User) error
}

type RedisCache struct {
    client *redis.Client
}

func NewRedisCache(client *redis.Client) *RedisCache {
    return &RedisCache{client: client}
}

func (c *RedisCache) Get(ctx context.Context, key string) ([]byte, error) {
    value, err := c.client.Get(ctx, key).Bytes()
    if errors.Is(err, redis.Nil) {
        return nil, ErrCacheMiss
    }
    if err != nil {
        return nil, err
    }
    return value, nil
}

func (c *RedisCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    return c.client.Set(ctx, key, value, ttl).Err()
}

func (c *RedisCache) Delete(ctx context.Context, key string) error {
    return c.client.Del(ctx, key).Err()
}

type SQLUserRepository struct {
    db *sql.DB
}

func NewSQLUserRepository(db *sql.DB) *SQLUserRepository {
    return &SQLUserRepository{db: db}
}

func (r *SQLUserRepository) GetByID(ctx context.Context, id string) (*User, error) {
    const query = `
        SELECT id, name, email, updated_at
        FROM users
        WHERE id = $1
    `

    var user User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &user.ID, &user.Name, &user.Email, &user.UpdatedAt,
    )
    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrUserNotFound
    }
    if err != nil {
        return nil, err
    }
    return &user, nil
}

func (r *SQLUserRepository) Update(ctx context.Context, user *User) error {
    const query = `
        UPDATE users
        SET name = $1, email = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING updated_at
    `

    err := r.db.QueryRowContext(
        ctx, query, user.Name, user.Email, user.ID,
    ).Scan(&user.UpdatedAt)
    if errors.Is(err, sql.ErrNoRows) {
        return ErrUserNotFound
    }
    return err
}

type UserService struct {
    cache Cache
    repo  UserRepository
    ttl   time.Duration
    log   *slog.Logger
}

func NewUserService(cache Cache, repo UserRepository, ttl time.Duration, logger *slog.Logger) (*UserService, error) {
    if cache == nil || repo == nil {
        return nil, errors.New("cache and repository are required")
    }
    if ttl <= 0 {
        return nil, errors.New("cache TTL must be positive")
    }
    if logger == nil {
        logger = slog.Default()
    }
    return &UserService{cache: cache, repo: repo, ttl: ttl, log: logger}, nil
}

func (s *UserService) cacheKey(id string) string {
    return "users:v1:" + id
}

func (s *UserService) GetByID(ctx context.Context, id string) (*User, error) {
    key := s.cacheKey(id)

    payload, err := s.cache.Get(ctx, key)
    switch {
    case err == nil:
        var user User
        if decodeErr := json.Unmarshal(payload, &user); decodeErr == nil {
            return &user, nil
        }
        s.log.WarnContext(ctx, "invalid cached user payload")
        if deleteErr := s.cache.Delete(ctx, key); deleteErr != nil {
            s.log.WarnContext(ctx, "failed to delete invalid cache entry", "error", deleteErr)
        }
    case errors.Is(err, ErrCacheMiss):
        // A miss is an expected cache-aside path.
    default:
        s.log.WarnContext(ctx, "cache read failed; bypassing cache", "error", err)
    }

    user, err := s.repo.GetByID(ctx, id)
    if err != nil {
        return nil, err
    }

    payload, err = json.Marshal(user)
    if err != nil {
        s.log.WarnContext(ctx, "failed to encode user for cache", "error", err)
        return user, nil
    }

    if err := s.cache.Set(ctx, key, payload, s.ttl); err != nil {
        s.log.WarnContext(ctx, "cache population failed", "error", err)
    }
    return user, nil
}

func (s *UserService) Update(ctx context.Context, user *User) error {
    if user == nil || user.ID == "" {
        return errors.New("user and user ID are required")
    }
    if err := s.repo.Update(ctx, user); err != nil {
        return err
    }

    if err := s.cache.Delete(ctx, s.cacheKey(user.ID)); err != nil {
        s.log.ErrorContext(ctx, "database updated but cache invalidation failed",
            "user_id", user.ID, "error", err)
        return fmt.Errorf("user updated, cache invalidation failed: %w", err)
    }
    return nil
}
~~~

The update method illustrates a partial failure: the database mutation may have committed even if invalidation fails. Returning an error can cause a client to retry an already-committed write. A production API should represent this carefully, use idempotent write semantics where needed, and alert on invalidation failures. If TTL-bounded staleness is acceptable, the service may return success while recording the cache failure.

This implementation does not solve stampedes or stale-repopulation races. Those require additional coordination or versioning.

## 8. Example usage

Assume the application has opened a PostgreSQL database connection as db and configured Redis:

~~~go
redisClient := redis.NewClient(&redis.Options{
    Addr: "localhost:6379",
})

if err := redisClient.Ping(ctx).Err(); err != nil {
    return err
}

repo := NewSQLUserRepository(db)
cache := NewRedisCache(redisClient)

service, err := NewUserService(
    cache,
    repo,
    5*time.Minute,
    slog.Default(),
)
if err != nil {
    return err
}

user, err := service.GetByID(ctx, "usr_123")
if err != nil {
    return err
}
_ = user
~~~

The first read for a cold key loads the database and populates Redis. Subsequent reads can return the cached representation until invalidation or expiration.

## 9. Production considerations

- **Consistency:** cache-aside does not guarantee strict consistency with the database. TTL bounds ordinary cache residence, but concurrent invalidation races and failed invalidations can extend stale visibility.
- **Failure isolation:** decide whether cache failures cause bypass, request failure, or degraded service. If bypassing, use concurrency limits, load shedding, or a circuit breaker to protect the database.
- **Stampedes:** concurrent misses for one popular key can all query the database. Request coalescing, per-key locks, or controlled refresh can reduce duplicate origin work.
- **Negative caching:** caching not-found results can protect the database from repeated absent-ID lookups. Use a short lifetime and invalidate the negative entry when the resource is created.
- **Key design:** include tenant and representation dimensions when they affect results. Avoid secrets and unbounded user-controlled strings in keys.
- **Payloads:** cache only fields needed by callers. Large values increase memory, network, and serialization costs.
- **Observability:** measure hit ratio, miss ratio, cache errors, origin queries, population failures, invalidation failures, payload size, and hit/miss latency.
- **Durability:** cache eviction or total cache loss must not destroy authoritative data.

## 10. Design tradeoffs

**Cache-aside vs write-through:** cache-aside loads only requested entries and keeps the application in control. Write-through proactively updates the cache on writes, reducing cold reads for known-hot data but increasing write-path coupling and potentially caching unused objects.

**Invalidation vs updating the cache:** deletion is simpler and usually safer because the next read reloads authoritative state. Updating the cache can avoid a subsequent miss but creates more opportunities for partial updates and stale-write races.

**Short vs long TTL:** a shorter lifetime limits ordinary stale residence but increases misses and origin load. A longer lifetime improves hit rate but increases stale visibility when invalidation fails.

**Shared vs process-local cache:** a shared cache lets service instances reuse entries and centralizes capacity, but adds network latency and a dependency. A process-local cache avoids the network hop but duplicates memory and complicates cross-instance invalidation.

Do not cache data whose correctness requires strict, immediately consistent reads unless the design includes a mechanism that satisfies that requirement. Do not add a cache before measuring whether the database is the bottleneck.

## 11. Connection to previous lessons

Day 2 defined API resources and operations. Day 3 mapped those operations to access patterns, constraints, and indexes.

Cache-aside adds a derived read path in front of the database:

~~~text
API read -> Cache lookup
                | hit -> Return
                | miss
                v
          Indexed database query
                |
                v
          Populate cache -> Return
~~~

The data model still determines origin query cost. The cache does not repair an unindexed query; it reduces how often that query executes for repeated keys.

Capacity estimates inform cache sizing and expected hit-rate benefits. Next, study TTL and eviction behavior, then stampedes and distributed invalidation.

## 12. What comes next

Next: **TTL and eviction policies**.

Cache-aside needs a policy for how long entries remain eligible for reuse and what happens when memory is full. TTL controls age-based expiration, while eviction controls removal under memory pressure. They solve different problems.

## Key Takeaways

- Cache-aside checks the cache first, loads the database on a miss, then populates the cache.
- The database remains the source of truth. Cached values must be reconstructible.
- Write the database first, then invalidate the cache after a successful commit.
- Cache invalidation is not a transaction with the database. Stale-read races remain possible.
- Cache failures need an explicit fallback and overload policy.
- Caching helps repeated reads when the workload has a useful working set and hit rate.
- Measure effectiveness rather than assuming it.

## Concept Map

~~~text
Day 1: Requirements and Capacity
                 |
                 v
Day 2: API Design
                 |
                 v
Day 3: Data Modeling and Access Patterns
                 |
                 v
Day 4: Cache-Aside
          |             |
          v             v
    TTL / Eviction   Invalidation
          |             |
          +------+------+
                 v
          Stampede Control
                 |
                 v
        Distributed Caching
~~~

## Exercise

Add cache-aside to the job service modeled in Day 3.

1. Cache job details by job ID.
2. Use a configurable TTL.
3. Invalidate after a successful job-state transition.
4. Preserve database correctness when Redis is unavailable.
5. Explain what happens if a reader loads the old state, a writer commits a new state and invalidates the key, and then the reader writes its old value into Redis.
6. Identify metrics needed to determine whether the cache is reducing database load.

Provide the cache key scheme, read/write sequence, and failure policy. Do not implement distributed locks or stampede control yet.

## Progress

- Day: 4
- Topic: Basic Caching with Cache-Aside
- Classification: HLD foundation + LLD integration pattern
- Concepts introduced: cache-aside, cache hit/miss paths, lazy population, cache invalidation, cache as derived state, cache-failure fallback
- Concepts reinforced: API access patterns, database as source of truth, TTL as a bounded-residence mechanism, read/write consistency
- Prerequisites satisfied: requirements and capacity estimation, API design, data modeling and access patterns
- Suggested next concepts: TTL and eviction policies, then cache stampede and invalidation races

## Most Important Mental Model

A cache is a disposable, derived copy of authoritative data, so every cache path must remain correct when entries disappear or the cache becomes unavailable.
