# DAY 5: TTL and Eviction Policies

## 1. Why this concept exists

Cache-aside from Day 4 explains how an entry gets into a cache. It does not answer two operational questions:

1. How long should the entry remain eligible to serve reads?
2. What happens when the cache runs out of memory before entries expire?

Time to live (TTL) and eviction policies answer different questions. TTL is an age-based expiration rule attached to an entry. Eviction is a capacity-management decision made when the cache needs memory.

Without TTL, stale or abandoned entries can remain indefinitely unless invalidated. Without an eviction policy, a bounded cache can reject writes or fail under memory pressure. A production cache needs both a freshness policy and a memory-pressure policy.

## 2. Core idea

### TTL: age-based expiration

A TTL defines how long a cache entry remains eligible to be returned after it is written.

For example, a product description might have a TTL of five minutes. Once the TTL elapses, a read should behave like a cache miss and reload the authoritative value.

TTL is not a synchronization mechanism. It does not make cache and database updates atomic, and it does not eliminate stale-repopulation races. It bounds the lifetime of a particular cached write, assuming that write is not replaced or refreshed.

Choose TTL based on:
- Maximum tolerable staleness.
- Update frequency.
- Origin cost and acceptable miss rate.
- Value size and cache capacity.
- Whether writes explicitly invalidate the key.

A shorter TTL usually reduces ordinary stale residence but increases misses and origin load. A longer TTL usually improves reuse but allows stale values to remain eligible longer if invalidation fails.

### Eviction: capacity-based removal

Eviction removes entries when memory pressure reaches the configured limit. It is independent of whether an entry's TTL has expired.

Redis documents policies including:
- `allkeys-lru`: evict keys estimated to be least recently used.
- `allkeys-lfu`: evict keys estimated to be least frequently used.
- `volatile-lru` and `volatile-lfu`: select only keys that have an expiration.
- `volatile-ttl`: select expiring keys with the shortest remaining TTL.
- `allkeys-random`: evict any key at random.
- `noeviction`: reject writes that need additional memory rather than evicting keys.

LRU favors recency. LFU favors repeated access frequency and can retain a frequently accessed key even if it has not been accessed very recently. Redis implements approximations rather than maintaining a perfect global ordering.

For a dedicated cache where every key is disposable, `allkeys-lru` or `allkeys-lfu` is often a reasonable starting point. Choose from observed access patterns and hit/miss metrics rather than assuming one policy is universally best.

### Expiration and eviction are not interchangeable

| Mechanism | Trigger | Decision |
|---|---|---|
| TTL expiration | Entry age crosses its deadline | Entry is no longer valid for cache reads |
| Eviction | Cache memory pressure | Policy chooses an entry to remove |
| Explicit invalidation | Application knows authoritative data changed | Application deletes or replaces a key |

A key can be evicted before its TTL expires. A key can also expire when memory pressure is low. Explicit invalidation is still useful when an update must make an old entry unavailable sooner than its TTL.

Redis documents both passive expiration, when an expired key is accessed, and active expiration, which periodically samples keys with expiration metadata. Therefore, expiration should be understood as a logical deadline, not as a precise application callback at the exact deadline. See the official [EXPIRE documentation](https://redis.io/docs/latest/commands/expire/) and [key eviction documentation](https://redis.io/docs/latest/develop/reference/eviction/).

### TTL jitter

If many entries are populated at the same time with the same TTL, they may expire together. Their misses can arrive together and overload the database. This is one cause of a cache stampede.

TTL jitter spreads expiration times. If the configured TTL is an upper bound, subtract a random amount from the base TTL rather than adding positive jitter.

For example, a base TTL of 5 minutes with up to 30 seconds of negative jitter produces lifetimes between 4 minutes 30 seconds and 5 minutes. This reduces synchronized expiration without exceeding the configured upper bound.

Jitter reduces synchronization; it does not guarantee that a hot key will not stampede.

## 3. Mental model

Think of TTL as the freshness clock and eviction as the memory-pressure valve.

- TTL asks: “Is this entry still eligible to be served?”
- Eviction asks: “Which entry should be removed to keep memory within budget?”
- Invalidation asks: “Has the application learned that this representation is no longer usable?”

A correct cache design answers all three independently.

## 4. Real-world example

### Publicly documented

Redis documents the available `maxmemory-policy` choices and recommends selecting a policy based on key access patterns. Its documentation describes `allkeys-lru` as a common default when a small subset of entries is accessed much more frequently than the rest, and explains that LFU can perform better for some frequency-skewed workloads. It also exposes statistics such as `evicted_keys` and `expired_keys` through `INFO`. Source: [Redis key eviction](https://redis.io/docs/latest/develop/reference/eviction/).

Redis documents `EXPIRE`, `TTL`, and `PTTL` for assigning and inspecting key lifetimes. Source: [Redis EXPIRE](https://redis.io/docs/latest/commands/expire/) and [Redis TTL](https://redis.io/docs/latest/commands/ttl/).

These are documented Redis behaviors, not claims about any particular company's private architecture.

### Industry-standard inference

For a cache serving product metadata with a hot set, LFU may retain frequently requested products better than pure recency-based eviction. For a workload where popularity changes quickly, LRU may adapt more directly to recent demand. Measure hit ratio and origin load under representative traffic before selecting the policy.

## 5. LLD

Keep the TTL policy explicit in the cache adapter. The service should request a cache write, while the adapter applies the configured lifetime and jitter.

```
Application Service
        |
        v
    Cache Interface
        |
        v
   Redis Adapter
        |
        +--> TTL calculation
        +--> atomic SET with expiration
        +--> cache metrics
        |
        v
     Redis Server
        |
        +--> expiration
        +--> maxmemory eviction policy
```

The application controls the per-entry TTL. Redis controls server-side eviction using configuration. Avoid implementing an application-level LRU on top of Redis unless there is a specific need. It duplicates policy, adds state and synchronization, and fights the cache server's own memory manager.

A useful interface keeps TTL configuration in the adapter or cache policy component rather than making every caller invent a duration independently.

## 6. HLD

```
                    API Instances
                         |
                         v
                    Shared Redis
                  /               \
                 v                 v
        TTL Expiration       maxmemory limit
                 |                 |
                 v                 v
         Entry becomes       LRU/LFU policy
         cache miss          evicts an entry
                 \                 /
                  \               /
                   v             v
                    API reads DB
                         |
                         v
                    Primary DB
```

The database remains authoritative. Both expiration and eviction cause a future read to miss and return to the origin path.

Production implications:
- A low TTL increases database traffic.
- A very high TTL can retain stale values when invalidation fails.
- A small memory limit can evict hot entries and reduce hit rate.
- A large memory limit without host headroom can trigger container or host memory pressure.
- Synchronized expirations can produce bursts of origin requests.
- A cache flush or restart produces a cold-cache load spike.

Configure a memory limit on the cache server and leave headroom for process overhead, allocator fragmentation, client buffers, replication buffers where applicable, and operating-system needs. Do not assume the entire container memory limit is available for cached values.

For a dedicated cache, `allkeys-lru` or `allkeys-lfu` lets Redis evict any cache key. A `volatile-*` policy only considers keys with expiration metadata; if no eligible expiring keys exist, writes can behave like `noeviction`. Mixing durable application data and disposable cache entries in one Redis instance makes eviction semantics harder to reason about. Prefer separating them when operationally feasible.

## 7. Code

This Go adapter applies a configurable base TTL and negative jitter. It uses go-redis's `Set` operation with an expiration, so the value and TTL are applied together rather than in separate commands.

Dependency:

~~~bash
go get github.com/redis/go-redis/v9
~~~

~~~go
package cachepolicy

import (
	"context"
	"errors"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrCacheMiss = errors.New("cache miss")

type Config struct {
	BaseTTL time.Duration
	MaxJitter time.Duration
}

type Cache struct {
	client *redis.Client
	baseTTL time.Duration
	maxJitter time.Duration
}

func New(client *redis.Client, cfg Config) (*Cache, error) {
	if client == nil {
		return nil, errors.New("redis client is required")
	}
	if cfg.BaseTTL <= 0 {
		return nil, errors.New("base TTL must be positive")
	}
	if cfg.MaxJitter < 0 || cfg.MaxJitter >= cfg.BaseTTL {
		return nil, errors.New("jitter must be non-negative and less than base TTL")
	}

	return &Cache{
		client: client,
		baseTTL: cfg.BaseTTL,
		maxJitter: cfg.MaxJitter,
	}, nil
}

func (c *Cache) nextTTL() time.Duration {
	if c.maxJitter == 0 {
		return c.baseTTL
	}

	jitter := time.Duration(rand.Int63n(int64(c.maxJitter) + 1))
	return c.baseTTL - jitter
}

func (c *Cache) Get(ctx context.Context, key string) ([]byte, error) {
	value, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrCacheMiss
	}
	if err != nil {
		return nil, err
	}
	return value, nil
}

func (c *Cache) Set(ctx context.Context, key string, value []byte) error {
	return c.client.Set(ctx, key, value, c.nextTTL()).Err()
}

func (c *Cache) Delete(ctx context.Context, key string) error {
	return c.client.Del(ctx, key).Err()
}

func (c *Cache) RemainingTTL(ctx context.Context, key string) (time.Duration, error) {
	ttl, err := c.client.TTL(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if ttl == -2*time.Nanosecond || ttl == -2*time.Second {
		return 0, ErrCacheMiss
	}
	if ttl < 0 {
		return 0, errors.New("cache entry has no expiration")
	}
	return ttl, nil
}
~~~

The Redis server's eviction policy is configured separately, for example in a dedicated cache instance's configuration:

~~~conf
maxmemory 4gb
maxmemory-policy allkeys-lfu
maxmemory-samples 10
~~~

The values are illustrative, not universal production defaults. Choose the memory limit from the actual container/host budget and workload. Benchmark LRU versus LFU against representative key popularity and request traces. If cached data is disposable and the workload has strong frequency skew, `allkeys-lfu` is a candidate, not an automatic choice.

## 8. Example usage

~~~go
client := redis.NewClient(&redis.Options{
	Addr: "localhost:6379",
})

cache, err := cachepolicy.New(client, cachepolicy.Config{
	BaseTTL: 5 * time.Minute,
	MaxJitter: 30 * time.Second,
})
if err != nil {
	return err
}

if err := cache.Set(ctx, "products:v1:prod_123", payload); err != nil {
	// Cache population failed. Apply the service's cache-failure policy.
	logger.WarnContext(ctx, "cache write failed", "error", err)
}

cached, err := cache.Get(ctx, "products:v1:prod_123")
switch {
case err == nil:
	return serve(cached)
case errors.Is(err, cachepolicy.ErrCacheMiss):
	return loadFromDatabase(ctx)
default:
	return handleCacheFailure(ctx, err)
}
~~~

In a real service, the cache miss path should load the database, populate the cache best-effort, and return the database result. Do not let cache population failure turn a successful origin read into a failed request unless the service explicitly requires the cache.

## 9. Production considerations

- **Freshness:** choose TTL from the business staleness budget and update behavior, not from a generic rule such as “five minutes is enough.”
- **Eviction telemetry:** monitor Redis `evicted_keys`, `expired_keys`, memory usage, rejected commands, hit/miss ratio, and origin database QPS.
- **Memory headroom:** account for Redis overhead, fragmentation, replication and client buffers. Set `maxmemory` below the total process/container limit.
- **Expiration bursts:** use TTL jitter for large cohorts populated together. Add request coalescing for extremely hot keys when needed.
- **Hot-set churn:** frequent evictions of popular entries indicate insufficient capacity, a poor policy, oversized values, or an unsuitable cache key strategy.
- **TTL preservation:** overwriting a Redis key with `SET` without an expiration can clear its existing TTL. Always set the intended expiration atomically with cache writes or explicitly preserve the TTL where that is the intended behavior.
- **No-eviction failures:** with `noeviction`, writes that require more memory can fail. Treat this as an explicit operational condition, not as a cache miss.
- **Correctness:** TTL is not a substitute for invalidation or transactional consistency. A stale reader can repopulate an old value after invalidation.
- **Testing:** test expiration, missing keys, Redis errors, memory-pressure behavior, and cache cold-start load in integration environments.

## 10. Design tradeoffs

**Short vs long TTL:** short TTL improves ordinary freshness but increases misses and origin load. Long TTL improves reuse but increases stale visibility when invalidation is missed.

**LRU vs LFU:** LRU adapts to recent access. LFU retains frequently accessed keys and may work better when popularity is stable and highly skewed. LFU's approximate counters and decay behavior mean it is not a perfect popularity oracle.

**allkeys vs volatile policies:** allkeys policies can evict any cache entry. Volatile policies restrict eviction to keys with TTLs, which can be useful in mixed datasets but can lead to write failures when no eligible keys remain. A dedicated cache is usually easier to operate than mixing durable and disposable data.

**Eviction vs noeviction:** eviction preserves write availability by discarding entries that can be rebuilt. Noeviction preserves existing keys but can reject new writes at the memory limit. For a disposable cache, rejecting cache writes may be preferable to destabilizing the database, but it should be an explicit choice.

**TTL jitter vs fixed TTL:** fixed TTL is predictable but can synchronize expiration. Jitter spreads load but makes individual entry lifetimes less uniform. Negative jitter preserves the configured TTL as an upper bound.

Do not use a cache eviction policy to implement business retention. If data must be retained for compliance or correctness, it is not disposable cache state.

## 11. Connection to previous lessons

Day 3 established the access patterns and authoritative database model. Day 4 introduced cache-aside and cache invalidation.

Today's concept completes the basic cache lifecycle:

~~~text
Read miss -> Populate cache with TTL
                    |
                    v
             Entry ages out
                    |
                    v
             Next read misses

Memory pressure -> Eviction policy removes an entry
                    |
                    v
             Next read misses

Database mutation -> Explicit invalidation
                    |
                    v
             Next read reloads authoritative state
~~~

The three removal mechanisms are related but have different triggers and guarantees. The next lesson will examine what happens when many requests encounter a miss at once or when concurrent reads race with invalidation.

## 12. What comes next

Next: **Cache stampede and invalidation races**.

TTL jitter spreads expiration, but does not prevent multiple concurrent misses for one hot key. Cache invalidation also has a stale-repopulation race. The next lesson will add request coalescing, bounded origin concurrency, and techniques for reasoning about stale writes.

## Key Takeaways

- TTL is age-based expiration. Eviction is capacity-based removal.
- Explicit invalidation is a third mechanism triggered by application knowledge.
- A shorter TTL improves ordinary freshness but increases misses and origin load.
- LRU favors recency; LFU favors frequency. Choose from observed workload.
- TTL jitter reduces synchronized expiration bursts.
- Configure Redis memory limits with process and host headroom.
- A cache remains disposable. Eviction must not destroy authoritative data.

## Concept Map

~~~text
Day 3: Data Modeling
         |
         v
Day 4: Cache-Aside
         |
         v
Day 5: TTL + Eviction
      /      |       \
     v       v        v
 Freshness  Memory   TTL Jitter
            Pressure    |
                        v
              Cache Stampede
                        |
                        v
             Invalidation Races
~~~

## Exercise

A product API caches 5 million product records in Redis. The product catalog changes every few minutes, 2% of products receive 70% of reads, and Redis has a strict 8 GiB memory budget.

Design the TTL and eviction policy.

Specify:
1. The freshness budget and TTL range.
2. Whether to use fixed TTL or jitter.
3. Whether LRU or LFU is the better initial candidate, and why.
4. What Redis memory limit to configure relative to the 8 GiB budget.
5. Which metrics would indicate excessive expiration or eviction.
6. What happens when Redis reaches its memory limit.
7. Why TTL and eviction do not solve stale-repopulation races.

Do not implement stampede control yet.

## Progress

- Day: 5
- Topic: TTL and Eviction Policies
- Classification: HLD caching policy + LLD cache adapter configuration
- Concepts introduced: TTL semantics, expiration, eviction, LRU, LFU, allkeys versus volatile policies, memory headroom, TTL jitter
- Concepts reinforced: cache-aside, invalidation, cache as disposable derived state, database fallback
- Prerequisites satisfied: requirements/capacity estimation, API design, data modeling, cache-aside
- Suggested next concept: cache stampede and invalidation races

## Most Important Mental Model

TTL decides when an entry ages out; eviction decides what to remove under memory pressure, and neither replaces explicit consistency handling.
