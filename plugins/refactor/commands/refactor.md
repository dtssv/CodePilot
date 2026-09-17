---
description: Perform a described refactoring safely across the codebase
argument-hint: <description>
allowed-tools: [bash, read_file, write_file, edit_file, glob, grep, diagnostics]
---

# Refactor

Perform the following refactoring across the codebase:

> $ARGUMENTS

## Step 1 — Scope the Change

- Identify every symbol/file affected: use `grep`/`glob` to find all
  definitions, references, imports, and string mentions.
- Check the `diagnostics` tool for a pre-existing error baseline — you must
  not increase the error count.
- Read each affected file's relevant regions before touching anything.

## Step 2 — Classify the Refactoring

Apply the matching safe-transformation pattern:

- **Extract function/method** — move a code block into a named function;
  parameters = used-but-defined-elsewhere variables; return = modified
  locals. Replace the original block with a call. Update all visibility
  rules (private/internal).
- **Rename symbol** — rename at the definition and *every* reference site,
  including imports, re-exports, doc comments, and string-based lookups
  (DI tokens, event names, config keys). Never use blind sed-style
  replace-all on names that are common words.
- **Inline variable/function** — the inverse of extract; only when the
  indirection adds nothing.
- **Simplify conditionals** — guard clauses for nested `if`s, de Morgan
  cleanups, replace conditionals with lookup tables/polymorphism where the
  repo already uses that pattern.
- **Modernize syntax** — apply the repo's language level: optional chaining,
  nullish coalescing, `const`/`let` over `var`, arrow functions where
  idiomatic, dataclasses, f-strings, etc. Match what's already in use —
  do not introduce syntax newer than the project's configured target.
- **Move/organize** — move a symbol to a new module and repair all imports.

## Step 3 — Execute Incrementally

- Make the smallest possible edit at each step; prefer many small
  `edit_file` calls over one giant rewrite.
- After each file, run `diagnostics` on it to catch breakage immediately.
- Keep behaviour identical: no drive-by fixes, no reformatting, no
  dependency changes, no test edits (except renames that tests reference).

## Step 4 — Verify

1. Run the project's checks: type check (`tsc --noEmit`, `mypy`, `go build
   ./...`...), linter, and the test suite (or at minimum the tests covering
   the touched modules).
2. Compare against the baseline from Step 1: zero new errors, all tests
   passing.
3. If verification fails and can't be fixed quickly: revert your edits
   (`git checkout -- <files>` or by reversing edits) and report why.

## Output

Report: refactoring performed, files changed (with counts), call sites
updated, verification commands run and their results, and any spots you
deliberately left untouched (with reasons).
