---
name: skill-creator
description: Create, improve, and edit CodePilot skills (SKILL.md). Use whenever the user wants to create a skill, write /skill-creator, turn a workflow into a skill, or edit an existing skill under ~/.codepilot/skills or .codepilot/skills.
when: The user asks to create or improve a skill, mentions skill-creator, or wants to capture a repeatable workflow as a skill.
tools:
  - write_file
  - edit_file
  - read_file
  - bash
  - grep
---

# skill-creator

Help the user create or improve a **CodePilot skill** — a folder with `SKILL.md` that the agent loads on demand via the `skill` tool.

## CodePilot skill locations

| Scope | Path | When to use |
|-------|------|-------------|
| User (default) | `~/.codepilot/skills/<name>/SKILL.md` | Personal skills across projects |
| Project | `<cwd>/.codepilot/skills/<name>/SKILL.md` | Shared with the repo |
| Builtin | shipped with CodePilot | Do not overwrite; copy to user/project to customize |

Directory name **must** match frontmatter `name` (lowercase, digits, hyphens).

## Capture intent

If the conversation already contains a workflow (“turn this into a skill”), extract steps, tools, corrections, and I/O formats first. Otherwise ask:

1. What should this skill enable the agent to do?
2. When should it trigger? (phrases / contexts)
3. Expected output format?
4. User-global or project-local?

Confirm before writing files.

## Write SKILL.md

```markdown
---
name: my-skill
description: What it does AND when to use it (include trigger phrases; be a bit pushy so it is not under-triggered).
when: Optional short hint.
tools:
  - read_file
  - bash
---

# my-skill

## Workflow
1. …
2. …

## Examples
…
```

### Description rules

- Third person; include **what** + **when**.
- Put all “when to use” info in `description`, not only in the body.
- Prefer imperative steps in the body; keep body under ~500 lines.
- Optional: `references/`, `scripts/`, `assets/` next to `SKILL.md` for progressive disclosure.

### Writing style

Prefer explaining *why* over heavy MUSTs. Stay general; avoid malware or deceptive skills.

## After writing

1. Write the file with `write_file` / `edit_file`.
2. Tell the user the path and that **new sessions** pick it up (or reload).
3. Suggest a short test prompt they can send to verify triggering.
4. Offer to iterate on the description if it under-triggers.

## Editing existing skills

- User/project skills: edit the `SKILL.md` in place.
- Builtin skills: copy to `~/.codepilot/skills/<name>/SKILL.md` first (user copy wins), then edit.
- Settings → 技能 also allows viewing/editing markdown; keep that file valid.

## Do not

- Create skills under Cursor-only paths (`~/.cursor/skills-cursor/`).
- Invent secrets or hard-code API keys into skills.
- Overwrite project skills without asking when a user copy would suffice.
