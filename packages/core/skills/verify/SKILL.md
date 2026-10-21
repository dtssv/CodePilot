---
name: verify
description: Run the project's relevant verification (test, build, lint, or acceptance check) and report the command plus exit outcome before claiming work is done.
when: After non-trivial edits, before marking a plan step completed, or when the user asks to verify / check / confirm the change.
tools:
  - bash
  - read_file
  - grep
  - glob
  - diagnostics
---

# verify

Use this skill when work needs evidence of correctness — not a task-specific
checklist, a generic verify-before-done gate.

## Workflow

1. Infer the right verify command from the repo (package scripts, Makefile,
   CI config, or project memory). Prefer the narrowest useful check first
   (unit/file-level), then broaden if the change is cross-cutting.
2. Run it with `bash` (or `diagnostics` when language-server feedback is enough).
3. On failure: read the failure, fix the root cause, re-run. Do not disable
   assertions or skip tests to force green.
4. On success: state the command and exit code in your reply. Only then mark
   related plan steps `completed` or claim the task done.

## Notes

- Visual / asset tasks: compare against the same reference evidence used to
  implement (e.g. `read_image` on a screenshot) in addition to any build step.
- If verification is impossible (missing tooling, no network, no harness), say
  so explicitly instead of pretending the change was verified.
