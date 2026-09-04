---
name: review
description: Read a diff (staged, unstaged, or branch-vs-base) and produce a structured code review with severity-tagged findings.
when: The user asks to review, audit, or critique a change.
tools:
  - bash
  - read_file
  - grep
---

# review

Use this skill when the user asks for a code review of a change set.

## Workflow

1. Determine the diff to review. Pick the right one:
   - Working tree: `git diff`
   - Staged: `git diff --cached`
   - vs. main: `git diff main...HEAD`
   - A specific commit: `git show <sha>`
   If unclear, ask the user.

2. Read the surrounding code for any region that is non-obvious. Do not
   review in a vacuum — context matters for naming, error handling, and
   invariant checks.

3. Walk the diff in source order. For each hunk, check:
   - **Correctness**: Does the code do what it claims? Are there off-by-one,
     null/undefined, async/await, or resource-leak bugs?
   - **Edge cases**: Empty inputs, very large inputs, concurrent access,
     partial failure.
   - **API surface**: Are public signatures backwards-compatible? Is the new
     error contract documented?
   - **Tests**: Is the change covered? Are the new tests meaningful (not
     tautological)?
   - **Naming / readability**: Would a new contributor understand this in 6
     months?
   - **Security**: Any untrusted input that reaches a sink? Any new secret
     handling?
   - **Performance**: Any obvious O(n²) where O(n) is available? Any
     accidental work in hot paths?

4. Output the review as a Markdown list. Tag each finding with a severity:

   - `[blocker]` — must fix before merge (correctness, security, data loss).
   - `[major]` — should fix; meaningful defect or maintainability hit.
   - `[minor]` — nitpick; would-be-nice polish.
   - `[nit]` — style / preference only.

   For each finding, cite the file and line range, quote the relevant code,
   and propose a concrete fix.

5. End the review with a short **summary**:
   - Overall verdict (`approve`, `request changes`, `comment`).
   - One-line per-file takeaway.
   - Anything you explicitly did **not** review (e.g. generated code,
     vendored dependencies).
