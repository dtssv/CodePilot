---
name: code-review
description: Detailed code review guidelines — OWASP top 10, anti-patterns, resource leaks, race conditions, and severity tagging.
when: The user asks to review code, audit a change, or run the /review command.
tools:
  - bash
  - read_file
  - grep
  - glob
---

# Code Review Guidelines

Load this skill whenever you perform a code review. Follow every checklist
below; skip an item only when it clearly does not apply to the language or
change under review.

## 1. Security — OWASP Top 10

Check for each of these explicitly:

- **A01 Broken Access Control** — missing authorization checks on handlers/routes, IDOR (user-controlled IDs used without ownership checks), CORS misconfiguration.
- **A02 Cryptographic Failures** — plaintext secrets at rest, MD5/SHA1 for passwords, hardcoded keys/IVs, `Math.random()` for security tokens.
- **A03 Injection** — string-concatenated SQL, `eval`/`new Function`, unsanitized shell arguments, template injection, XSS via unescaped output.
- **A04 Insecure Design** — missing rate limiting on auth endpoints, missing abuse-case handling.
- **A05 Security Misconfiguration** — debug flags in prod paths, overly permissive defaults, stack traces returned to clients.
- **A06 Vulnerable Components** — dependencies with known CVEs (check lockfiles; run `npm audit` / `pip audit` / `govulncheck` when available).
- **A07 Auth Failures** — weak session handling, missing MFA hooks, predictable reset tokens, credentials in URLs/logs.
- **A08 Data Integrity Failures** — unsafe deserialization, unsigned CI/CD artifacts, auto-update without signature checks.
- **A09 Logging Failures** — security-relevant events not logged; secrets or PII written to logs.
- **A10 SSRF** — server-side requests built from user input without allowlists.

## 2. Common Anti-Patterns

- God functions/classes (hundreds of lines, many responsibilities).
- Shotgun surgery risk: one change requiring edits across many files.
- Copy-pasted logic that should be shared (rule of three).
- Deeply nested conditionals (`if` pyramids) — prefer early returns/guard clauses.
- Magic numbers/strings without named constants.
- Catch-all `except`/`catch` blocks that swallow or rethrow without context.
- Boolean parameters that fork behaviour — prefer explicit functions or options objects.
- Comments that restate the code instead of explaining *why*.

## 3. Resource Leaks

For every acquisition, find the matching release:

- File handles, sockets, DB connections — closed on *all* paths (incl. exceptions)?
- Streams — consumed/destroyed? Backpressure handled?
- Timers/intervals — cleared when the owner is torn down?
- Event listeners/subscriptions — removed on dispose?
- Locks/semaphores — released in `finally` (or RAII)?
- Caches — bounded? Eviction policy present?
- Goroutines/threads/async tasks — do they terminate? Who joins them?

## 4. Race Conditions & Concurrency

- Shared mutable state without synchronization.
- Check-then-act (TOCTOU) on files, records, or flags.
- Async code that mutates captured variables after an `await`.
- Missing idempotency on retry-prone operations (payments, webhooks).
- Lock ordering inconsistencies (potential deadlock).
- Fire-and-forget promises without error handlers (`void promise` / floating promises).

## 5. Correctness Basics

- Off-by-one in loops and slices.
- Null/undefined/None handling at boundaries.
- Integer overflow/underflow; float equality comparisons.
- Timezone and DST handling for dates.
- Error types lost when crossing layers (stack/context preserved?).

## 6. Severity Rubric

Assign exactly one severity per finding:

| Severity   | Use when |
|------------|----------|
| `[critical]` | Exploitable security issue, data loss/corruption, crash/hang in production. Blocks merge. |
| `[major]`    | Real defect, missing error handling on important paths, significant perf regression, broken API contract. |
| `[minor]`    | Small defect with easy workaround, readability drag, mild duplication. |
| `[info]`     | Question, observation, or optional suggestion. |

## 7. Review Discipline

- Read surrounding context before judging — never review a hunk in isolation.
- Distinguish facts from taste; flag facts, suggest on taste with `[info]`.
- Every finding must cite `file:line-range` and propose a concrete fix.
- Do not flag generated code, vendored code, or lockfiles (note them as excluded).
- End with a summary: verdict, findings per severity, per-file takeaways, exclusions.
