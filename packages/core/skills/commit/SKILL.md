---
name: commit
description: Generate a Conventional Commits message and create a single logical commit for the current staged/unstaged work.
when: The user asks to commit, save, or record the current change.
tools:
  - bash
  - read_file
  - grep
---

# commit

Use this skill when the user asks to commit the current change set.

## Workflow

1. Inspect the working tree:
   - `git status --short`
   - `git diff --stat`
   - `git log -5 --oneline` to confirm the project's commit style.

2. Decide what belongs in the commit. The default is **one logical commit** for
   everything the user just asked for. If the change set mixes unrelated concerns
   (e.g. a feature and a refactor), stop and ask the user before splitting.

3. Stage the relevant files with `git add <paths>`. Do **not** stage
   `.codepilot/`, `dist/`, `node_modules/`, or anything covered by
   `.gitignore`.

4. Write the commit message in **Conventional Commits** format:

       <type>(<scope>)<!>: <short summary>

       <body — explain WHY, not what. Wrap at 72 cols.>

       <footer — references, breaking-change notes>

   - `type` is one of `feat`, `fix`, `chore`, `docs`, `refactor`,
     `test`, `perf`, `build`, `ci`, `style`, `revert`.
   - `!` marks a breaking change.
   - Subject ≤ 72 chars, imperative mood, no trailing period.
   - If the project uses a different convention (look at `git log`), follow
     that instead.

5. Create the commit with `git commit -m "<subject>" -m "<body>"`. Use a
   single `-m` per paragraph for clean formatting.

6. Do **not** push, force-push, amend, or rewrite history. If the user asked
   for any of those, confirm before doing it.

7. Report the new commit's short SHA and subject in your final message.
