---
description: Generate documentation for a file or directory
argument-hint: <file-or-dir>
allowed-tools: [bash, read_file, write_file, edit_file, glob, grep]
---

# Generate Documentation

Generate documentation for the target: `$1`
Additional instructions (may be empty): $ARGUMENTS

## Step 1 — Survey the Target

- If `$1` is a **file**: read it fully and inventory its exported API —
  functions, classes, methods, types, constants.
- If `$1` is a **directory**: use `glob` to list its source files, read the
  entry points (index/main files) and public modules, and map how the pieces
  relate.

Also check for existing docs (`README.md`, `docs/`, doc comments) so new
output extends rather than contradicts them.

## Step 2 — Choose the Right Output

Pick based on the target and the repo's existing documentation culture:

1. **API doc comments** — add JSDoc/TSDoc (`/** ... */` with `@param`,
   `@returns`, `@throws`, `@example`), Python docstrings (Google style),
   Go doc comments, or rustdoc to exported symbols that lack them.
   Use `edit_file` to insert comments in place. Do not reformat code.
2. **README section** — when the target is a package/module: overview,
   install, quick-start (runnable example), API summary, configuration
   table. Write with `write_file` or extend via `edit_file`.
3. **Architecture notes** — for a directory: a short `ARCHITECTURE.md` or
   README section describing components, data flow, and key decisions.
   Include a Mermaid diagram (`graph TD` / `sequenceDiagram`) when
   component relationships are non-obvious.

## Step 3 — Writing Standards

- **Document the contract, not the implementation**: what callers must
  provide, what they get back, what can throw, and any preconditions.
- Every non-trivial public function gets: one-line summary, parameter docs,
  return doc, throws/error doc, and a minimal `@example` when usage is not
  obvious.
- Examples must be real and runnable — verify import paths and signatures
  against the actual code with `grep`/`read_file`.
- Match the repo's existing doc style (verbosity, heading hierarchy, tense).
- No filler ("This function does stuff"). If a symbol is truly
  self-explanatory, a one-line summary suffices.

## Step 4 — Verify and Report

- For doc comments: re-read edited files to confirm comments sit correctly
  and code is untouched. Run the project's type check or doc build if one
  exists (`tsc --noEmit`, `typedoc`, `cargo doc`, `pydoc`...).
- Finish with a report: files modified/created, symbols documented, and any
  verification command output.
