---
description: Say hello — the minimal slash-command example
argument-hint: "[name]"
allowed-tools: []
---

# Hello

Greet the user and confirm the plugin is wired up correctly.

If `$ARGUMENTS` is non-empty, greet that name specifically:

> Hello, **$1**! The `hello-world` plugin is installed and its command is live.

Otherwise, greet generically:

> Hello! The `hello-world` plugin is installed and its command is live.

Then, in one short sentence, tell the user they can copy `plugins/hello-world/`
to start building their own plugin.
