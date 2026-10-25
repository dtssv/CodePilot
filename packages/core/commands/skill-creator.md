---
description: Create or improve a CodePilot skill (guided by skill-creator)
argument-hint: "[what the skill should do]"
---

Load the **skill-creator** skill with the `skill` tool, then follow it to create or improve a CodePilot skill.

User request / topic: $ARGUMENTS

Defaults unless the user says otherwise:
- Write to `~/.codepilot/skills/<name>/SKILL.md` (user-global)
- Interview briefly for purpose, triggers, and output format before writing
- After writing, report the path and a sample test prompt
