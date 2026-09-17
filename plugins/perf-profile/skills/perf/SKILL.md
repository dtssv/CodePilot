---
name: perf
description: Performance analysis guidelines — profiling tools, flame graphs, memory profiling, async patterns, and database query optimization.
when: The user asks to profile, benchmark, or optimize performance.
tools:
  - read_file
  - grep
  - glob
  - bash
---

# Performance Analysis Guidelines

Load this skill for profiling and optimization work. The discipline:
**measure first, optimize second, verify third**. Never optimize on
intuition alone — attach a number to every claim.

## 1. The Performance Loop

1. **Baseline** — record current numbers (latency, throughput, memory,
   benchmark time) before touching code.
2. **Profile** — find where time/memory actually goes.
3. **Optimize the top hotspot only** — the biggest term dominates; fixing
   #4 while #1 burns 60% is wasted effort.
4. **Re-measure** — same conditions as baseline; report the delta.
5. Stop when returns diminish or the target is met. Optimization has a
   readability cost — pay it only for measured wins.

## 2. Profiling Tools by Stack

| Stack | CPU | Memory/Heap | Wall-clock/live |
|-------|-----|-------------|-----------------|
| Node | `node --prof` / `--cpu-prof`, `0x` | `--inspect` heap snapshots, `clinic heapprofiler` | `console.time`, `perf_hooks` |
| Python | `cProfile`, `pyinstrument` | `tracemalloc`, `memray` | `py-spy top/dump/record` |
| Go | `pprof` (`-cpuprofile`) | `pprof` (`-memprofile`), `-benchmem` | `go test -bench`, runtime/trace |
| Rust | `perf`, `samply` | `heaptrack`, DHAT | criterion `cargo bench` |
| Java | async-profiler, JFR | JFR OldObjectSample, `jmap -histo` | JMH for microbenchmarks |

Flame graphs: generate from sampled stacks (`py-spy record -o out.svg`,
`0x`, async-profiler `-f flame.html`). Read them bottom-up for callers,
top-down for self-time. Wide plateaus = where time goes; tall thin towers
are noise.

## 3. Common Bottleneck Patterns

- **Algorithmic**: nested iteration (O(n²)), repeated linear search in a
  loop (build a Map/Set index), per-iteration sorting, regex compiled
  inside loops, accidental exponential recursion without memoization.
- **Allocation churn**: creating objects/strings/arrays in hot loops,
  spread-copy of large structures, `JSON.parse(JSON.stringify())` cloning,
  boxing primitives in tight loops.
- **I/O amplification**: N+1 database queries, per-record HTTP calls,
  reading files line-by-line through a remote FS, missing connection
  pooling, absent response caching.
- **Serialization**: re-encoding the same payload per request, oversized
  JSON where a compact format fits, pretty-printing in production.
- **Lock contention**: coarse global locks in hot paths, sync-over-async
  bridges, thread pool starvation.

## 4. Async & Concurrency Patterns

- **Sequential awaits in a loop** → batch independent work with
  `Promise.all` / `asyncio.gather` / goroutines + WaitGroup. Bound
  concurrency (semaphore/pool) when the fan-out is large.
- **Backpressure**: streaming APIs — honor it; buffering everything
  defeats streaming's memory benefit.
- **Event-loop health (Node)**: no sync fs/crypto/JSON-of-megabytes on the
  loop; offload CPU-heavy work to worker_threads.
- **Debounce/batch/coalesce** high-frequency events instead of handling
  each individually.
- **Cancellation**: propagate it (AbortController, context.Context) so
  abandoned work stops burning resources.

## 5. Memory Leak Signals

- Monotonically growing heap across GC cycles (compare consecutive heap
  snapshots; look at retained size, not just object counts).
- Classic sources: unbounded `Map`/cache without eviction, listeners/timers
  never removed, closures pinning large scopes, promises never settled,
  detached DOM nodes (browser), goroutines blocked on channels forever.
- Caches must have a size bound + eviction (LRU) or TTL — flag any
  `new Map()` used as a cache without one.

## 6. Database Query Optimization

- **N+1**: one query per row in a loop → eager loading / `IN` batching /
  join. Count queries per request in a log or ORM listener.
- **Missing indexes**: sequential scans on filtered/sorted columns — check
  `EXPLAIN` (or `EXPLAIN ANALYZE`) plans for the slow queries.
- **Select only what's needed**: avoid `SELECT *` on wide tables in hot
  paths; avoid loading entities to update one column.
- **Pagination**: keyset/cursor over `OFFSET` for deep pages.
- **Over-fetching relationships**: eager-load graphs pruned to what the
  response actually serializes.
- **Connection pool sizing**: too small = queueing; too large = DB
  overload. Match pool to measured concurrency.

## 7. Reporting Standard

Every optimization claim needs: the evidence (profile/screenshot/command
output), the mechanism (why it's slow), the fix sketch, and the expected
vs. measured improvement. Record what you deliberately did NOT optimize
and why (readability cost, cold path, diminishing returns).
