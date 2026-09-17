---
name: refactor
description: Refactoring guidelines — safe transformation patterns, verification steps, and rollback strategies.
when: The user asks to refactor, restructure, rename, extract, simplify, or modernize code.
tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
  - bash
---

# Refactoring Guidelines

Load this skill before any refactoring. The prime directive: **behaviour must
not change**. A refactoring is a semantics-preserving transformation —
features and fixes are separate commits.

## 1. The Safety Loop

For every refactoring, run this loop:

1. **Baseline** — capture current state: run type checks and tests; note
   counts. Record `git status` so rollback is possible.
2. **Small step** — one transformation, one file or one call-site cluster
   at a time.
3. **Check** — type check / run tests for the touched module immediately.
4. **Commit-point mindset** — the tree should be green after every step, so
   a failed step can be reverted without losing earlier work.

Never batch multiple *kinds* of transformation into one edit.

## 2. Safe Transformation Patterns

### Extract Function
- Inputs: variables read but not defined in the block → parameters.
- Outputs: locals written in the block and read after → return values
  (tuple/object when >1).
- Preserve evaluation order of side effects — if the block interleaves with
  surrounding I/O, extraction may change behaviour; flag it.
- Name for intent (`parseRetryPolicy`), not mechanics (`doStuff2`).

### Rename Symbol
- Find *all* reference classes: direct calls, imports/re-exports, string
  references (DI tokens, reflection, templates, event names, config keys),
  and documentation.
- Rename public API last and check for external consumers (`grep` for the
  name across the whole repo, including tests and examples).
- If the symbol is part of a published interface, note the breaking change
  instead of silently renaming.

### Simplify Conditionals
- Guard clauses: `if (!ok) return/throw` at the top, flattening pyramids.
- De Morgan: `!(a || b)` → `!a && !b` only when it aids readability.
- Lookup tables replace switch-chains that map keys → values/behaviours.
- Preserve short-circuit side effects: `f() && g()` is not interchangeable
  with `g() && f()` when `f` has effects.

### Modernize Syntax
- Only apply syntax the project's configured language level supports
  (check `tsconfig.json` target, `.python-version`, `go.mod`, etc.).
- Examples: optional chaining `?.`, nullish `??` (NOT `||` — different
  falsy semantics!), `Object.hasOwn`, f-strings, structural pattern
  matching, records, `var` → `const`/`let`.
- `||` → `??` is the classic trap: `""`/`0`/`false` are falsy but not
  nullish. Verify the left operand's domain before converting.

### Move Symbol to Module
- Create the destination, re-export from the origin if external consumers
  may exist, update all imports, then remove the shim only after the tree
  is green.

## 3. Verification Steps (in order)

1. `diagnostics` / compiler / type checker — zero new errors.
2. Linter — zero new warnings.
3. Tests covering touched modules — all green.
4. Full test suite when the refactor crosses module boundaries.
5. Diff review — read your own diff; it should contain *only* the
   transformation, no unrelated changes.

## 4. Rollback Strategies

- **Before starting**: ensure the working tree state is known (`git
  status`). Recommend committing or stashing unrelated work.
- **Per-file rollback**: `git checkout -- <file>` restores any file whose
  edits go wrong.
- **Full rollback**: `git checkout -- .` (or `git stash`) returns to the
  baseline. Always tell the user before a full rollback.
- **Never** run destructive git commands (reset --hard, clean) without
  explicit user confirmation.
- If tests fail post-refactor and the cause isn't obvious within a couple
  of iterations: roll back the last step, re-verify green, then retry with
  a smaller step.

## 5. Out of Scope (flag, don't do)

- Behaviour changes, bug fixes, feature additions — mention them, don't mix.
- Dependency upgrades needed *for* the refactor — ask first.
- Reformatting untouched code.
- Renaming things whose references can't all be found (dynamic lookups).
