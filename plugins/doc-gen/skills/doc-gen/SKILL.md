---
name: doc-gen
description: Documentation generation guidelines — JSDoc/TSDoc format, README structure, architecture decision records, and diagram conventions.
when: The user asks to document code, write docs, or update a README.
tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
---

# Documentation Generation Guidelines

Load this skill when writing or updating documentation. Good docs answer the
reader's questions in the order they arise: what is this, how do I use it,
what can go wrong, where do I look deeper.

## 1. API Doc Comments

### JSDoc / TSDoc (JavaScript / TypeScript)

```ts
/**
 * Short one-line summary (imperative mood).
 *
 * Longer explanation only when the behaviour is non-obvious: side effects,
 * invariants, complexity, or lifecycle notes.
 *
 * @param options.name - Must be unique per workspace.
 * @returns The created record, including its generated `id`.
 * @throws {ConflictError} When `name` already exists.
 * @example
 * const rec = await createRecord({ name: "demo" });
 * @since 2.1.0
 */
```

Rules:
- In TypeScript, **do not** duplicate types in doc tags (`@param {string}` is
  redundant) — the type system already says it. Document *semantics*: units,
  allowed ranges, nullability meaning, ownership of returned values.
- Every exported symbol gets a comment; internal helpers only when non-obvious.
- Tags worth using: `@param`, `@returns`, `@throws`, `@example`,
  `@deprecated` (with replacement), `@see`, `@internal`.

### Other Languages (match ecosystem idioms)

- **Python**: Google-style docstrings — summary line, `Args:`, `Returns:`,
  `Raises:`, `Examples:`.
- **Go**: sentence starting with the identifier name; document package
  purpose in `doc.go` or the package comment.
- **Rust**: `///` with `# Examples` fenced block that `cargo test --doc` runs;
  `# Errors` / `# Panics` sections.
- **Java/Kotlin**: Javadoc/KDoc with `@param`, `@return`, `@throws`.

## 2. README Structure

A complete README answers, in order:

1. **Name + one-line pitch** — what it does, for whom.
2. **Status badges** — only ones already used by the project.
3. **Install** — exact command, prerequisites.
4. **Quick start** — the smallest runnable example; verify it compiles/runs.
5. **Usage** — the 80% cases, each with a short example.
6. **Configuration** — a table: name, type, default, description.
7. **API summary** — links into generated docs or key signatures.
8. **Contributing / License** — only if the project already has these files.

Keep code fences language-tagged. Prefer links over duplicating content that
lives elsewhere.

## 3. Architecture Documentation

For module-level docs, describe:

- **Components** — one bullet each: name, responsibility, key files.
- **Data flow** — how a request/record moves through the system.
- **Key decisions** — and *why*, not just what.
- **Diagrams** — use Mermaid so they render on GitHub and stay diffable:

  ````markdown
  ```mermaid
  graph TD
    CLI --> Session
    Session --> Agent
    Agent --> Tools
  ```
  ````

  Use `sequenceDiagram` for protocol/timing questions, `graph TD/LR` for
  structure. Keep diagrams under ~15 nodes; split rather than sprawl.

## 4. Architecture Decision Records (ADRs)

When documenting a significant decision, use the standard ADR shape:

```markdown
# ADR-NNNN: Title

- Status: proposed | accepted | deprecated | superseded by ADR-XXXX
- Date: YYYY-MM-DD

## Context
What forces are at play? What problem are we solving?

## Decision
What we decided, stated in active voice.

## Consequences
What becomes easier or harder; follow-up work; risks.
```

Number sequentially in `docs/adr/` (check for existing numbering first).

## 5. Style Rules

- Write for the reader who knows the domain but not this codebase.
- Present tense, active voice, imperative for instructions.
- Every claim about behaviour must be verified against the code — never
  document what code *should* do, only what it *does*.
- Keep line length reasonable in Markdown source; one sentence per line is
  ideal for diffability.
- Update the table of contents / links when adding sections.
