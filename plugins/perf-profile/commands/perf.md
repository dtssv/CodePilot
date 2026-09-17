---
description: Profile performance of a path and identify optimization opportunities
argument-hint: [path]
allowed-tools: [bash, read_file, grep, glob, diagnostics]
---

# Performance Profile

Analyze the performance of: $ARGUMENTS
If no path was given, analyze the most likely hot paths of the repository
(entry points, request handlers, loops over unbounded data).

## Step 1 — Static Hotspot Review

Read the target code and flag:

- **Algorithmic issues**: nested loops over the same collection (O(n²)),
  repeated `indexOf`/`includes`/`find` inside loops, unbounded recursion,
  repeated sorting, accidental re-computation that could be memoized.
- **Allocation pressure**: object/array creation inside hot loops, string
  concatenation in loops (use builders/joins), unnecessary copies
  (`[...arr]`, `JSON.parse(JSON.stringify(x))`), large intermediate
  collections where streaming would do.
- **Async/concurrency**: sequential `await` in loops (parallelize with
  `Promise.all` where independent), missing batching, unbounded
  concurrency, blocking I/O on a single-threaded runtime.
- **I/O patterns**: per-item queries (N+1), missing pagination, repeated
  reads of the same file/config, absent caching of pure lookups.
- **Memory leak risks**: unbounded caches/Maps, listeners never removed,
  closures capturing large scopes, growing arrays in long-lived objects,
  missing stream backpressure.

Use `diagnostics` and `grep` to find related call sites before claiming a
path is hot.

## Step 2 — Dynamic Profiling (when feasible)

Only when the repo has a runnable harness (test, script, benchmark):

- Node: `node --prof <entry>` (then `node --prof-process`), or
  `node --cpu-prof --cpu-prof-dir /tmp ...`; for memory,
  `node --inspect` + heap snapshots, or `clinic` if installed.
- Python: `python -m cProfile -o out.pstats <script>` (+ `py-spy` if
  installed for live sampling), `tracemalloc` for allocations.
- Go: `go test -bench . -benchmem -cpuprofile cpu.out -memprofile mem.out`
  then `go tool pprof`.
- Rust: `cargo bench` (criterion), or `perf` on Linux.
- Java: JFR (`-XX:StartFlightRecording`) or async-profiler if present.

If no harness exists, do NOT create services or install global tools.
Fall back to Step 1 evidence plus a concrete measurement plan the user can
run.

## Step 3 — Report

Markdown report with:

1. **Hotspots** — ranked list. Each: `file:line`, quoted snippet, why it's
   costly (complexity/allocations/I-O), estimated impact, and a concrete
   optimization sketch.
2. **Memory risks** — suspected leaks with the growth mechanism explained.
3. **Quick wins** — changes likely to give outsized gains for small diffs.
4. **Measurement plan** — exact commands to profile/benchmark, and the
   baseline metric to record before optimizing.
5. **Exclusions** — what wasn't analyzed and why.

Severity tags: `[critical]` user-facing latency/outage risk ·
`[major]` real waste at expected load · `[minor]` micro-optimization ·
`[info]` observation. Never recommend rewriting to a different
language/framework.
