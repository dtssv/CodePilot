---
name: test-gen
description: Test generation guidelines — AAA pattern, edge cases, mocking strategies, and coverage goals for any framework.
when: The user asks to generate, write, or improve tests.
tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
  - bash
---

# Test Generation Guidelines

Load this skill when writing or extending test suites. The goal is tests that
fail when behaviour breaks — and never otherwise.

## 1. Structure — Arrange / Act / Assert

Every test follows AAA, visually separated:

```
// Arrange — set up inputs, fakes, and the system under test
// Act     — perform exactly one behaviour
// Assert  — verify the observable outcome
```

- One behaviour per test. If you write "and" in the test name, split it.
- Test names read as specifications:
  `retries twice before surfacing the error`, not `testRetry`.
- Keep tests independent: no shared mutable state, no ordering assumptions.
  Prefer fresh fixtures per test (`beforeEach`/fixtures/factory functions).

## 2. Edge-Case Matrix

For each input parameter, consider:

- **Emptiness**: `""`, `[]`, `{}`, `null`, `undefined`, `None`, `0`, `false`.
- **Boundaries**: min/max values, off-by-one neighbours, first/last element.
- **Shape**: single element, many elements, duplicate keys, deeply nested.
- **Text**: unicode, emoji, RTL, very long strings, whitespace-only, NUL.
- **Numbers**: negative, zero, float precision, `NaN`, `Infinity`, overflow.
- **Time**: midnight, DST transitions, leap seconds/years, far past/future.
- **Concurrency**: repeated calls, interleaved awaits, cancellation mid-flight.
- **Failures**: dependency throws/times out/returns malformed data.

Pick the cases that the unit's contract actually promises — do not pad.

## 3. Mocking Strategies

Mock at the **seam** — the boundary between your code and what you don't own:

- **Mock**: network/HTTP clients, databases, filesystems, clocks/timers,
  randomness, process/env, third-party SDKs.
- **Don't mock**: the unit under test, plain value objects, pure helpers.
- **Prefer fakes over deep mocks** when the fake is simple (in-memory repo
  over a mocked ORM). Deep mocks couple tests to implementation details.
- **Verify interactions only when the interaction IS the contract**
  (e.g. "must call `audit.log` exactly once"). Otherwise assert on outcomes.
- Reset/restore mocks between tests to prevent leakage.
- Match the repo's existing approach (vitest `vi.mock`, jest `jest.mock`,
  pytest `monkeypatch`/fixtures, Go interfaces, Mockito `@Mock`).

## 4. Framework Quick Reference

| Stack | Framework | File convention |
|-------|-----------|-----------------|
| TS/JS | vitest / jest / mocha | `*.test.ts`, `*.spec.ts`, `__tests__/` |
| Python | pytest / unittest | `tests/test_*.py`, `conftest.py` fixtures |
| Go | testing + table-driven | `*_test.go` beside source |
| Rust | built-in | `#[cfg(test)]` module, `tests/` dir |
| Java/Kotlin | JUnit 5 + Mockito | `src/test/...` mirroring packages |

Always mirror the conventions already present in the repository.

## 5. Coverage Goals

- **Target**: every public/exported unit has at least happy-path + one
  error-path test. Critical modules (auth, money, data mutation) deserve
  the full edge-case matrix.
- **Branches over lines**: aim to cover decision branches, not just execute
  lines.
- **Do not chase 100% blindly** — generated code, trivial getters, and
  defensive unreachable branches need no tests.
- When a coverage tool exists (`vitest --coverage`, `pytest --cov`,
  `go test -cover`), run it on the touched module and report the delta.

## 6. Quality Gates Before Finishing

1. Run the new tests — they must pass.
2. Sanity-check they can fail: would a deliberate behaviour change trip them?
   (Tests that can never fail are worse than none.)
3. No sleeps for synchronization — use proper async awaiting/polling helpers.
4. No tests hitting real network/db unless the suite is explicitly
   integration-tier and the repo isolates those (markers/tags/profiles).
5. Report what was tested, what was skipped, and why.
