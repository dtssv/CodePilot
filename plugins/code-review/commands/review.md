---
description: Run a comprehensive code review on a path or the current diff
argument-hint: [path]
allowed-tools: [bash, read_file, grep, glob]
---

# Code Review

Run a comprehensive code review on: $ARGUMENTS

If no path was given (or `$1` is empty), review the current working-tree diff instead:
- Run `git diff` (and `git diff --cached`) to gather the change set.
- Run `git status --short` to see untracked files worth including.

## Review Scope

Examine the target for all of the following:

1. **Security vulnerabilities** — injection (SQL, shell, XSS, template), hardcoded secrets, unsafe deserialization, missing auth checks, path traversal, SSRF, weak crypto.
2. **Performance issues** — O(n²) or worse where O(n) is available, N+1 queries, unnecessary allocations in hot paths, missing pagination, unbounded caches, blocking I/O on the event loop.
3. **Style inconsistencies** — deviations from the project's existing conventions (naming, formatting, module layout, error types). Read neighbouring files to learn the house style before flagging anything.
4. **Missing error handling** — swallowed exceptions, unchecked returns, missing timeouts/retries on network calls, partial-failure paths that leak resources.
5. **Test coverage gaps** — changed logic without matching tests, tests that assert nothing meaningful, missing edge-case coverage (empty/null/maximal/concurrent inputs).

## Output Format

Produce a Markdown report. Group findings by file, then by line range. Tag every finding with exactly one severity:

- `[critical]` — exploitable security flaw, data loss, or crash. Must fix before merge.
- `[major]` — real defect or meaningful maintainability/performance hit. Should fix.
- `[minor]` — small issue or polish opportunity.
- `[info]` — observation, question, or suggestion; no action strictly required.

For each finding:
- Cite `file:line-range`.
- Quote the offending snippet (trim to the essentials).
- Explain *why* it is a problem in one or two sentences.
- Propose a concrete fix (a short code sketch when useful).

End with a **Summary** section:
- Overall verdict: `approve`, `approve with comments`, or `request changes`.
- Count of findings per severity.
- One-line per-file takeaway.
- Anything explicitly not reviewed (generated code, vendored deps, etc.).
