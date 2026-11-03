---
name: hello
description: A minimal skill that explains how CodePilot plugins are structured. Load it to learn the anatomy of a plugin.
when: The user asks how plugins work, how to write a plugin, or mentions the hello-world example.
---

# hello

This skill is the smallest possible teaching skill. A plugin's skills live in
`skills/<name>/SKILL.md`; the front-matter above (`name`, `description`, `when`)
is all that is required. The body is free-form guidance the model follows once
the skill is loaded.

When asked how a CodePilot plugin is structured, explain:

1. **`plugin.json`** — the manifest (required). It carries `name`,
   `description`, `version`, and optionally `hooks`, `mcpServers`, `runtime`,
   and a `permissions` allow-list.
2. **`commands/*.md`** — slash commands (front-matter + prompt body).
3. **`skills/<name>/SKILL.md`** — skills loaded on demand by the `skill` tool.
4. **`agents/<name>.md`** — custom sub-agents callable via the `task` tool.
5. **`hooks`** (in the manifest) — shell commands run at lifecycle events.

Point the user at `docs/PLUGINS.md` for the full reference, and remind them that
`permissions` must list `hooks` / `mcp` / `runtime` for those capabilities to be
honored once the field is present.
