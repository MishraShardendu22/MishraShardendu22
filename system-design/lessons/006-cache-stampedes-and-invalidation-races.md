# DAY 6: Cache Stampedes and Invalidation Races

## 1. Why this concept exists

Days 4 and 5 established cache-aside, TTL, and eviction. Those mechanisms still leave two concurrency hazards.

A cache stampede occurs when many requests miss the same key and independently execute the same expensive origin query. It often happens when a hot key expires, is evicted, or is invalidated. The cache has converted a normally cheap read into a synchronized burst against the database.

An invalidation race occurs when a reader starts loading an old value, a writer commits a newer value and deletes the cache entry, and the reader then writes its old result into the cache after the deletion.

These are different problems:

- A stampede duplicates origin work.
- A stale-repopulation race can leave the cache containing an obsolete value after invalidation.

TTL jitter helps with synchronized expiration but does not eliminate concurrent misses for a single hot key. Deleting a key after a write does not prevent an in-flight reader from recreating it.

## 2. Core idea

### Stampede control with single-flight

Within one process, single-flight coalesces concurrent requests for the same key into one in-flight load.

```text
Request A ----+
Request B ----+----> Single-flight(key) ----> Origin read
Request C ----+              |
                             +---- result shared with A, B, C
```

The group is keyed by resource identity. Calls for different keys proceed independently.

Single-flight is not a cache and does not coordinate separate application instances. In a fleet of 20 API nodes, a local single-flight group can still permit up to 20 origin loads for the same cold key.

For cross-instance coordination, use a distributed per-key lock or another shared coordination mechanism. A common Redis approach is an atomic `SET lock-key token NX PX lease`. Only the lock owner loads the origin. Other callers wait briefly and recheck the cache.

The lock must be released conditionally: delete it only if its current value still matches the owner's unique token. Otherwise, an expired lease may have been acquired by a new owner, and the old owner could accidentally release the new owner's lock.

### Invalidation race

Consider this interleaving:

```text
Reader R1                    Writer W
---------                    --------
Cache miss
Read DB version 10
                             Commit version 11
                             Delete cache key
Write version 10 to cache
```

The delete succeeded, but the old reader repopulated the key afterward. A TTL only bounds the stale residence time. It does not prevent the race.

A useful mitigation is to make cache population conditional on still owning the per-key lock, and to make invalidation acquire that same lock before deleting the cache entry.

```text
Reader:
  acquire lock
  recheck cache
  load origin
  SET cache only if lock token is still current
  release lock

Writer:
  commit database
  acquire same lock
  delete cache
  release lock
```

If the reader owns the lock first, it finishes or loses its lease before the writer invalidates. If its lease expires while it is loading, its conditional cache write is rejected. The writer deletes after acquiring the lock, so a stale loader cannot repopulate the entry after invalidation completes.

This does not make the database commit and Redis invalidation atomic. A request may still read the old cached value between the database commit and successful invalidation. If invalidation fails, stale data can remain until TTL expiry. Strict read-after-write consistency requires a stronger contract, such as bypassing the cache for the relevant read, or an architecture with durable invalidation and version-aware reads.

### Distributed lock limitations

A lock lease is not proof that the holder is still the owner. The process can pause, the lease can expire, and another process can acquire the lock. Every side effect performed after acquiring a lease must account for lease loss.

The conditional cache-write script below checks the token atomically with the cache write. This prevents an expired owner from overwriting the value written by a newer owner.

The protocol only works if every cache fill and invalidation for that key follows it. A code path that writes the cache without the lock bypasses the protection.

## 3. Mental model

Treat cache population as a concurrent write that must prove it still has permission to publish.

Single-flight answers: **How many origin loads should happen for one key at a time?**

A per-key lock coordinates that work across processes. A token-checked cache write answers: **Does this loader still own the right to publish its result?**

Invalidation must participate in the same coordination protocol. Otherwise, the reader and writer are not actually ordered with respect to each other.

## 4. Real-world example

### Publicly documented

Redis's official cache-aside guide for Go describes the stampede scenario where many callers observe a miss for the same hot key and query the primary concurrently. It demonstrates a Redis lock acquired with `SET NX PX` and a compare-and-delete script that releases the lock only when the token matches. It also demonstrates cache invalidation after a primary-store write.

Source: [Redis cache-aside with Go](https://redis.io/docs/latest/develop/use-cases/cache-aside/go/).

Redis's general cache-aside documentation also describes Lua scripting as a way to perform atomic cache coordination operations.

Source: [Redis cache-aside](https://redis.io/docs/latest/develop/use-cases/cache-aside/).

These sources document Redis patterns. They do not establish the private cache architecture of any unrelated company.

### Industry-standard inference

For a hot entity endpoint, per-key coalescing can reduce origin work from approximately one read per concurrent request to one read per participating coordination domain, assuming the loader finishes within its coordination lease.

Local single-flight reduces duplicate work within each process. A distributed lock can reduce it across the fleet, but adds Redis round trips, lock contention, lease management, and a dependency on the coordination store.

## 5. LLD

The service owns the read policy. The cache adapter implements atomic lock operations and conditional writes. The repository remains the authoritative source.

```text
UserService
   |
   +--> Single-flight group, process-local
   |
   +--> Cache adapter
   |       +--> GET cache value
   |       +--> SET NX PX lock
   |       +--> SET value only if token still owns lock
   |       +--> DEL lock only if token matches
   |       +--> DEL cache while holding lock
   |
   +--> UserRepository
           +--> authoritative database read/write
```

Useful responsibilities:

- `UserService`: orchestration, retry/wait policy, timeouts, and error semantics.
- `Cache`: cache access and atomic coordination primitives.
- `UserRepository`: database operations and transaction boundaries.
- `singleflight.Group`: coalescing duplicate work inside one process.

The distributed lock is justified when duplicate origin work is costly enough to justify coordination. Do not add it to every cache key automatically. For cheap queries or low-contention keys, local single-flight and bounded origin concurrency may be sufficient.

## 6. HLD

```text
                 Clients
                    |
                    v
               Load Balancer
                    |
          +---------+---------+
          |                   |
          v                   v
       API Node A          API Node B
          |                   |
          +---------+---------+
                    |
                    v
                Redis Cache
              /      |      \
             /       |       \
        data key   lock key   TTL
             |
        cache miss
             |
             v
        Primary DB
```

### Stampede flow

1. A hot key expires or is evicted.
2. Many requests observe a miss.
3. One request acquires the per-key lock.
4. Other requests wait with bounded polling and recheck the cache.
5. The owner loads the database and conditionally populates the cache.
6. Waiters receive the populated value instead of issuing duplicate origin reads.

### Invalidation flow

1. The writer commits the database mutation.
2. The writer acquires the same per-key lock used by cache loaders.
3. It deletes the cached representation.
4. It releases the lock.
5. The next reader loads the new authoritative value.

### Failure modes and bottlenecks

- **Loader exceeds lease:** another caller can acquire the lock. Token-checked cache writes prevent the expired owner from publishing.
- **Lock acquisition fails:** fail or use a separately bounded fallback. Unbounded direct database fallback can turn a Redis outage into a database outage.
- **Invalidation fails after database commit:** stale cache data may remain until expiry. Durable retry, often via a transactional outbox or change-data-capture pipeline, is needed if invalidation must not be lost.
- **Waiters poll aggressively:** Redis traffic increases. Use bounded backoff with jitter and request deadlines.
- **Hot key:** one lock serializes origin loads for that key. This is intentional, but it can increase tail latency. Consider stale-while-revalidate or request shedding if the freshness contract permits it.
- **Redis failover:** lock ownership and lease behavior must be evaluated against the deployment's failover semantics. A Redis lock is not a general-purpose consensus or fencing system.
- **Lock expiry:** the token check prevents an old owner from publishing through this cache adapter, but it does not fence unrelated external side effects.

## 7. Code

The following Go implementation combines process-local single-flight with a Redis per-key lease. Both cache fills and invalidations use the same lock. Cache writes and lock release use Lua scripts to check ownership atomically.

Dependencies:

```bash
go get github.com/redis/go-redis/v9 golang.org/x/sync/singleflight
```

The example assumes Go 1.21 or later, a Redis deployment, and a repository whose `Update` method commits before returning. IDs must be canonical and safe for the Redis hash-tag format used by the key builder.

```go
package cachecoord

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

var ErrCacheMiss = errors.New("cache miss")

type User struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	UpdatedAt time.Time `json:"updated_at"`
}

type UserRepository interface {
	GetByID(context.Context, string) (*User, error)
	Update(context.Context, *User) error
}

type Cache interface {
	Get(context.Context, string) ([]byte, error)
	TryLock(context.Context, string, string, time.Duration) (bool, error)
	SetIfLockOwner(context.Context, string, string, string, []byte, time.Duration) (bool, error)
	UnlockIfOwner(context.Context, string, string) error
	Delete(context.Context, string) error
}

type RedisCache struct {
	client *redis.Client
}

func NewRedisCache(client *redis.Client) (*RedisCache, error) {
	if client == nil {
		return nil, errors.New("redis client is required")
	}
	return &RedisCache{client: client}, nil
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

func (c *RedisCache) TryLock(
	ctx context.Context,
	key string,
	token string,
	ttl time.Duration,
) (bool, error) {
	return c.client.SetNX(ctx, key, token, ttl).Result()
}

const setIfOwnerScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`

func (c *RedisCache) SetIfLockOwner(
	ctx context.Context,
	lockKey string,
	token string,
	cacheKey string,
	payload []byte,
	ttl time.Duration,
) (bool, error) {
	result, err := c.client.Eval(
		ctx,
		setIfOwnerScript,
		[]string{lockKey, cacheKey},
		token,
		payload,
		ttl.Milliseconds(),
	).Int64()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

const unlockIfOwnerScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

func (c *RedisCache) UnlockIfOwner(
	ctx context.Context,
	key string,
	token string,
) error {
	return c.client.Eval(
		ctx,
		unlockIfOwnerScript,
		[]string{key},
		token,
	).Err()
}

func (c *RedisCache) Delete(ctx context.Context, key string) error {
	return c.client.Del(ctx, key).Err()
}

type Config struct {
	CacheTTL         time.Duration
	LockTTL          time.Duration
	OriginTimeout    time.Duration
	InvalidationWait time.Duration
}

type Service struct {
	cache Cache
	repo  UserRepository
	cfg   Config
	log   *slog.Logger
	group singleflight.Group
}

func NewService(
	cache Cache,
	repo UserRepository,
	cfg Config,
	logger *slog.Logger,
) (*Service, error) {
	if cache == nil || repo == nil {
		return nil, errors.New("cache and repository are required")
	}
	if cfg.CacheTTL <= 0 || cfg.OriginTimeout <= 0 || cfg.InvalidationWait <= 0 {
		return nil, errors.New("cache TTL and timeouts must be positive")
	}
	if cfg.LockTTL <= cfg.OriginTimeout {
		return nil, errors.New("lock TTL should exceed the origin timeout")
	}
	if logger == nil {
		logger = slog.Default()
	}

	return &Service{
		cache: cache,
		repo:  repo,
		cfg:   cfg,
		log:   logger,
	}, nil
}

func (s *Service) cacheKey(id string) string {
	return "users:{" + id + "}:data"
}

func (s *Service) lockKey(id string) string {
	return "users:{" + id + "}:lock"
}

func newToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (s *Service) readCached(ctx context.Context, id string) (*User, bool, error) {
	key := s.cacheKey(id)
	payload, err := s.cache.Get(ctx, key)

	if errors.Is(err, ErrCacheMiss) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	var user User
	if err := json.Unmarshal(payload, &user); err == nil {
		return &user, true, nil
	}

	s.log.WarnContext(ctx, "invalid cached user payload", "user_id", id)
	if err := s.cache.Delete(ctx, key); err != nil {
		s.log.WarnContext(ctx, "failed to remove invalid cache entry", "error", err)
	}
	return nil, false, nil
}

func (s *Service) GetByID(ctx context.Context, id string) (*User, error) {
	if id == "" {
		return nil, errors.New("user ID is required")
	}

	user, hit, err := s.readCached(ctx, id)
	if err != nil {
		return nil, err
	}
	if hit {
		return user, nil
	}

	resultCh := s.group.DoChan(id, func() (any, error) {
		loadCtx, cancel := context.WithTimeout(
			context.WithoutCancel(ctx),
			s.cfg.OriginTimeout,
		)
		defer cancel()
		return s.loadWithLock(loadCtx, id)
	})

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultCh:
		if result.Err != nil {
			return nil, result.Err
		}
		user, ok := result.Val.(*User)
		if !ok {
			return nil, errors.New("unexpected cache loader result")
		}
		return user, nil
	}
}

func (s *Service) acquireLock(ctx context.Context, id string) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}

	key := s.lockKey(id)
	for {
		acquired, err := s.cache.TryLock(ctx, key, token, s.cfg.LockTTL)
		if err != nil {
			return "", err
		}
		if acquired {
			return token, nil
		}

		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *Service) releaseLock(id, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	if err := s.cache.UnlockIfOwner(ctx, s.lockKey(id), token); err != nil {
		s.log.WarnContext(ctx, "failed to release cache lock", "user_id", id, "error", err)
	}
}

func (s *Service) loadWithLock(ctx context.Context, id string) (*User, error) {
	for {
		token, err := s.acquireLock(ctx, id)
		if err != nil {
			return nil, err
		}

		user, retry, loadErr := s.loadWhileLocked(ctx, id, token)
		s.releaseLock(id, token)

		if loadErr != nil {
			return nil, loadErr
		}
		if retry {
			continue
		}
		return user, nil
	}
}

func (s *Service) loadWhileLocked(
	ctx context.Context,
	id string,
	token string,
) (*User, bool, error) {
	user, hit, err := s.readCached(ctx, id)
	if err != nil {
		return nil, false, err
	}
	if hit {
		return user, false, nil
	}

	user, err = s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, false, err
	}

	payload, err := json.Marshal(user)
	if err != nil {
		return nil, false, err
	}

	stored, err := s.cache.SetIfLockOwner(
		ctx,
		s.lockKey(id),
		token,
		s.cacheKey(id),
		payload,
		s.cfg.CacheTTL,
	)
	if err != nil {
		return nil, false, err
	}
	if !stored {
		// The lease expired or ownership changed. Do not publish this result.
		return nil, true, nil
	}

	return user, false, nil
}

func (s *Service) Update(ctx context.Context, user *User) error {
	if user == nil || user.ID == "" {
		return errors.New("user and user ID are required")
	}

	if err := s.repo.Update(ctx, user); err != nil {
		return err
	}

	// The database has committed. Give invalidation a bounded chance to finish
	// even if the caller disconnects; a durable outbox is needed for crash safety.
	invalidateCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		s.cfg.InvalidationWait,
	)
	defer cancel()

	token, err := s.acquireLock(invalidateCtx, user.ID)
	if err != nil {
		return fmt.Errorf("database update committed; cache invalidation pending: %w", err)
	}
	defer s.releaseLock(user.ID, token)

	if err := s.cache.Delete(invalidateCtx, s.cacheKey(user.ID)); err != nil {
		return fmt.Errorf("database update committed; cache invalidation pending: %w", err)
	}

	return nil
}
```

The lock and data keys use the same Redis Cluster hash tag, `{userID}`, so the Lua script can operate on both keys in one cluster slot.

The code intentionally fails the read when Redis coordination is unavailable. A service that chooses to bypass Redis must impose a separate origin concurrency limit and load-shedding policy. Otherwise, the fallback path can produce a database stampede during a cache outage.

The code also assumes cache invalidation is retried if it fails. A process can crash after the database commit and before invalidation, so a durable outbox or change-data-capture mechanism is required when losing an invalidation event is unacceptable.

## 8. Example usage

```go
client := redis.NewClient(&redis.Options{
	Addr: "localhost:6379",
})

cache, err := NewRedisCache(client)
if err != nil {
	return err
}

service, err := NewService(
	cache,
	userRepository,
	Config{
		CacheTTL:         5 * time.Minute,
		LockTTL:          3 * time.Second,
		OriginTimeout:    2 * time.Second,
		InvalidationWait: 2 * time.Second,
	},
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
```

The first cold read loads the origin under a per-key lock. Concurrent callers in the same process are coalesced by single-flight. Callers in other processes contend on the Redis lock and recheck the cache instead of immediately querying the database.

## 9. Production considerations

- **Lock lease:** choose a lease longer than the normal origin latency, but do not rely on duration alone. Enforce an origin timeout and make cache publication conditional on token ownership.
- **Polling:** use bounded backoff with jitter and honor request deadlines. Fixed rapid polling can itself become a Redis load problem.
- **Origin bulkhead:** if Redis is unavailable and the service bypasses it, cap concurrent origin loads and shed excess load.
- **Invalidation durability:** database commit and Redis deletion are not one atomic transaction. Use a transactional outbox or CDC when invalidation must survive process crashes.
- **Consistency contract:** the protocol prevents stale repopulation after invalidation completes, but does not eliminate the interval between database commit and invalidation. Strict read-after-write requirements may need cache bypass or version-aware reads.
- **All writers must cooperate:** direct cache writes or invalidations outside the protocol can reintroduce the race.
- **Metrics:** track coalesced calls, lock contention, lock acquisition latency, lease loss, origin loads per key, cache hit ratio, invalidation failures, and wait timeouts.
- **Hot keys:** single-flight serializes origin loads for a key. For extremely hot data, stale-while-revalidate or request shedding can be better if the freshness contract permits stale responses.
- **Redis topology:** evaluate lock behavior during failover and partitions. A Redis lease is not a general-purpose consensus guarantee.
- **Security:** use canonical resource IDs in keys and never use untrusted raw values that can manipulate Redis Cluster hash tags.

## 10. Design tradeoffs

| Technique | Benefit | Cost or limitation |
|---|---|---|
| Process-local single-flight | Simple, low overhead, suppresses duplicate work within one instance | Does not coordinate other instances |
| Distributed per-key lock | Coordinates loaders across instances | Redis round trips, contention, leases, failure modes |
| Token-checked publication | Prevents an expired lock owner from overwriting cache through this protocol | All cache writers must use the conditional operation |
| TTL jitter | Reduces synchronized expiration across many keys | Does not prevent a single hot key from stampeding |
| Stale-while-revalidate | Keeps hot-key reads fast during refresh | Explicitly serves stale data within a defined policy |
| Bounded origin fallback | Preserves some availability during cache failures | May reject or delay requests when the origin budget is exhausted |
| Transactional outbox / CDC | Makes invalidation retryable across process crashes | Adds durable event processing and operational complexity |

Do not introduce a distributed lock just to avoid a few duplicate cheap reads. Use the least expensive coordination mechanism that meets the origin-load and consistency requirements.

## 11. Connection to previous lessons

Day 4 introduced cache-aside and explicit invalidation. Day 5 introduced TTL, eviction, and TTL jitter.

Those mechanisms define the cache lifecycle but do not serialize concurrent misses or order a stale reader against a writer.

The dependency chain is now:

```text
Data Modeling
     |
     v
Cache-Aside
     |
     v
TTL and Eviction
     |
     +----> Synchronized misses
     |          |
     |          v
     |     Single-flight / distributed lock
     |
     +----> Stale repopulation
                |
                v
         Lock-coordinated invalidation
```

## 12. What comes next

**Day 7: Basic Queues and Producer-Consumer Design.**

The next foundation is asynchronous work. Queues decouple request acceptance from downstream processing, introduce buffering, and create new questions about delivery semantics, worker concurrency, retries, and backpressure.

## Key Takeaways

- A cache stampede duplicates origin work after concurrent misses.
- Local single-flight coalesces duplicate loads only within one process.
- A distributed per-key lock coordinates cache fills across instances.
- Release locks only when the token matches the current owner.
- Conditional cache writes prevent expired lock owners from publishing.
- Invalidation must coordinate with cache fills to prevent stale repopulation after invalidation completes.
- Database commit and cache invalidation are not atomic; durable retry is required if invalidation cannot be lost.
- TTL jitter reduces synchronized expiration but does not solve per-key concurrency.

## Concept Map

```text
Day 4: Cache-Aside
        |
        v
Day 5: TTL + Eviction
        |
        v
Day 6: Cache Concurrency Hazards
        |                    |
        v                    v
   Stampede             Invalidation Race
        |                    |
        v                    v
 Single-flight          Shared per-key lock
        |                    |
        +----------+---------+
                   v
        Conditional cache publication
                   |
                   v
          Durable invalidation (outbox/CDC)
```

## Exercise

A service runs 30 API instances. One product key receives 8,000 reads per second, the cache entry expires, and the database can safely sustain only 200 reads per second for that product's shard.

Design a cache-miss coordination strategy.

Specify:

1. What process-local single-flight solves and what it does not.
2. How a Redis per-key lock is acquired and safely released.
3. How the loader behaves if its lease expires during a database read.
4. How a writer prevents an in-flight stale read from repopulating the key after invalidation completes.
5. What the API does when Redis is unavailable.
6. Which metrics would reveal lock contention, stampedes, and invalidation failures.
7. Whether stale-while-revalidate is acceptable for this product and what freshness contract it requires.

Do not design a distributed queue yet.

## Progress

- Day: 6
- Topic: Cache Stampedes and Invalidation Races
- Classification: HLD cache coordination + LLD concurrency control
- Concepts introduced: request coalescing, process-local single-flight, distributed per-key locks, lease tokens, conditional cache publication, coordinated invalidation, bounded origin fallback
- Concepts reinforced: cache-aside, TTL/eviction, database authority, failure handling, consistency boundaries
- Prerequisites satisfied: requirements/capacity estimation, API design, data modeling, cache-aside, TTL and eviction
- Suggested next concept: basic queues and producer-consumer design

## Most Important Mental Model

Cache population is a concurrent write: a loader must still own the right to publish, and invalidation must participate in the same coordination protocol.
