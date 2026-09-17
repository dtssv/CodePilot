---
description: Generate tests for a source file, auto-detecting the test framework
argument-hint: <file>
allowed-tools: [bash, read_file, write_file, edit_file, glob, grep]
---

# Generate Tests

Generate a test suite for the source file: `$1`
Additional instructions (may be empty): $ARGUMENTS

## Step 1 — Read the Source

Read `$1` completely. Inventory every exported function, class, and method.
Note side effects, async boundaries, external dependencies, and error paths.

## Step 2 — Auto-Detect the Test Framework

Inspect the repo to pick the right framework and conventions:

- **JavaScript/TypeScript**: check `package.json` devDependencies and existing
  test files. Use `vitest` if configured (`vitest.config.*`, `vitest` dep),
  else `jest` (jest config, `jest` dep), else `mocha` (+ chai/sinon if present).
  Mirror the existing test file naming: `*.test.ts` vs `*.spec.ts` vs `__tests__/`.
- **Python**: `pytest` if `pytest.ini`/`pyproject.toml`/existing `tests/` use it;
  otherwise `unittest`. Follow existing fixture/conftest patterns.
- **Go**: standard `testing` package, table-driven tests, `_test.go` suffix.
- **Rust**: `#[cfg(test)] mod tests` in-file, or `tests/` for integration.
- **Java/Kotlin**: JUnit 5 (`@Test`, `@ParameterizedTest`) with Mockito if
  already on the classpath; check `build.gradle`/`pom.xml`.

When the repo already has tests, match their style exactly — assertion
library, setup/teardown helpers, naming, and folder layout.

## Step 3 — Write the Tests

For each public unit, write tests covering:

1. **Happy path** — typical inputs produce expected outputs.
2. **Edge cases** — empty, null/undefined/None, zero, negative, maximal,
   boundary values, unicode/whitespace-only strings.
3. **Error paths** — invalid inputs raise/reject/return errors as documented.
4. **Async behaviour** — resolution, rejection, timeout, and ordering where
   applicable.
5. **Side effects** — mock/stub external dependencies (network, fs, db,
   clock, random). Verify calls when the interaction is the contract.

Use the **Arrange–Act–Assert** structure. One behaviour per test. Descriptive
test names that read as specifications (`rejects when the queue is empty`).

## Step 4 — Place and Verify

- Create the test file at the location the repo's conventions dictate
  (sibling `*.test.*`, `tests/` mirror, etc.). Use `write_file` for a new
  file, `edit_file` to extend an existing one.
- Run the new tests with the project's runner (e.g. `npx vitest run <file>`,
  `npx jest <file>`, `pytest <file>`, `go test ./...`).
- If tests fail, fix the *tests* unless you find a genuine source bug — in
  that case, report the bug instead of weakening the test.

## Output

Finish with a short report: framework detected, test file path, number of
tests written, coverage of the source's exported surface (which units are
tested / intentionally skipped), and the test-run result.
