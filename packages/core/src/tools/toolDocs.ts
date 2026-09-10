// Per-tool reference docs injected into the system prompt's Tool Reference
// section. Each entry mirrors the claude-code style: a short "when to use",
// "when NOT to use", key gotchas, and a compact example.
//
// Keeping these here (rather than inline in each tool file) lets the system
// prompt builder pull a uniform block per tool without duplicating the
// longer prose in the tool's own `description` (which is what the model
// sees in the tools list). The `description` stays short; this is the
// "manual" the model can read in the static prefix.

export const TOOL_REFERENCE: Record<string, string> = {
  read_file: `When to use: seeing file contents before editing (editing without reading is forbidden), reviewing code, checking exact text for a search/replace.
When NOT to use: discovery (prefer \`grep\`/\`glob\`), directories (use \`ls\`), or re-reading a file already in your context (it has not changed unless you changed it).
Output: \`cat -n\` style — each line is \`<lineNumber>\\t<content>\`. Cite \`path:line\` in edits and reports. Lines >2000 chars are truncated inline.
Gotchas: files >60KB spill to an artifact — the result keeps the head plus an \`art_<hash>\` ref; pull slices with \`read_artifact\`. Binary files are detected and refused. Reads outside the sandbox (e.g. \`~/.ssh\`) are refused.
Example: \`read_file({ path: "src/auth.ts", startLine: 100, maxLines: 50 })\` → lines 101-150 of the file.`,
  read_image: `When to use: any task where SEEING the pixels matters — a UI screenshot to reproduce, a diagram to explain, a chart to analyse, a design mockup to implement, an error dialog to debug. Returns the image as a vision block alongside a text confirmation.
When NOT to use: text files (\`read_file\`), binary inspection (\`bash\` + \`xxd\`/\`file\`), or an image you already loaded this turn (it is still in context — re-loading wastes a call).
Formats: jpeg/png/gif/webp only. Over 20MB is refused — downsample first (\`sips -Z 2000\` on macOS, \`convert -resize\` with ImageMagick).
Gotcha: pass a short \`note\` describing what the image shows — it helps you reason about what you're looking at. The image counts against your context budget; don't load more than you need.`,

  edit_file: `When to use: changing an existing file. Prefer over \`write_file\` for any change smaller than a full rewrite.
When NOT to use: creating a new file (\`write_file\`), or a near-complete rewrite (\`write_file\` is clearer).
Modes: single-edit (\`search\` + \`replace\` at top level) OR multi-edit (\`edits: [{search, replace, ...}]\` — applied in order, transactional: any failure rolls back, error names the failing index).
Match strategies (tried in order): exact → trimmed-whitespace → unique-single-line → regex (with \`regex: true\`). Use \`global_replace: true\` to replace every occurrence.
GOTCHA: you MUST have read the file first. The \`search\` string must match the file verbatim (including indentation). If match fails, the error tells you which strategy was tried — adjust and retry, do not loop on the same input.
Example (multi-edit): \`edit_file({ path: "src/api.ts", edits: [{ search: "const old = 1;", replace: "const old = 2;" }, { search: "return old;", replace: "return old + 1;" }] })\``,
  write_file: `When to use: creating a new file, or doing a near-complete rewrite of an existing one.
When NOT to use: small changes to an existing file (\`edit_file\` keeps diffs small and reviewable).
Gotchas: overwrites unconditionally — there is no "merge". Always \`read_file\` an existing file first if you want to preserve any of it. Paths outside the sandbox are refused.`,
  apply_patch: `When to use: cross-file refactors (rename a symbol + update all callers, move code between files, add+update+delete in one go) where partial application would break the tree.
When NOT to use: single-file edits (\`edit_file\` is simpler), or creating one new file (\`write_file\`).
Format: \`*** Begin Patch\` … \`*** End Patch\` with \`*** Add File:\`/\`*** Delete File:\`/\`*** Update File:\` directives. Update hunks use \` \`=context, \`-\`=remove, \`+\`=add lines, anchored by \`@@\`.
Atomicity: if ANY hunk fails to match, NO file is written. The error names the failing file + hunk.
Gotchas: copy context/removed lines verbatim from \`read_file\` output (no line-number prefix). Hunks apply in order; later hunks see earlier hunks' results within the same file.`,
  diagnostics: `When to use: AFTER editing, to verify the file type-checks/lints without a full build. Cheap and pinpoints exact lines.
When NOT to use: before editing (irrelevant), or when no LSP is connected (the tool will tell you — fall back to \`bash\` with the project's type-checker/linter).
Filtering: \`severity\` defaults to \`error\`; set \`warning\`/ \`info\`/ \`hint\` for more. Omit \`path\` for workspace-wide (host may cap).
Gotcha: diagnostics reflect the LSP's view of the file on disk — if you edited in-memory only, write first. Empty result = clean.`,

  bash: `When to use: tests/builds/linters, git queries, package-manager commands, ad-hoc inspection the dedicated tools can't do.
When NOT to use: reading files (\`read_file\`/\`grep\`/\`glob\` — no shell escaping, line-numbered output), editing files (\`edit_file\`/\`write_file\`), or communicating with the user (just write text).
Foreground: 60s default timeout (max 10 min via \`timeout\`), 5MB output cap, outputs >8KB spill to an artifact. \`[exit <code>]\` prefix on non-zero.
Background: \`run_in_background: true\` returns \`job_<id>\` immediately — use for dev servers, watch mode, long builds. Poll with \`bash_output\`, stop with \`bash_kill\`.
GOTCHA: each foreground call is a FRESH shell — \`cd\`, env exports, and background jobs do NOT persist across calls. For stateful sequences, chain with \`&&\` in one call. (A persistent-shell upgrade is on the roadmap.)
Sandbox: writes confined to the workspace. Dangerous commands (\`rm -rf\`, force-push, drop-table, \`curl|sh\`) require explicit user approval — when in doubt, describe what you would run instead.`,

  bash_output: `When to use: reading the output of a background job started with \`bash({ run_in_background: true })\`.
Returns: job status (running/exited/killed/failed/unknown) + the tail of the log (default last 100 lines, configurable via \`tail\`). After exit, the exit code is in the metadata.
GOTCHA: if CodePilot restarted, a job marked "running" on disk is reported as "unknown" — the pid may be dead or reused.`,

  bash_kill: `When to use: stopping a background job. Sends SIGTERM. Returns false if the process is no longer alive.`,

  grep: `When to use: finding where a symbol/string/pattern appears in the codebase. Faster and cheaper than opening every candidate file with \`read_file\`.
When NOT to use: finding files by name (\`glob\`), listing a directory (\`ls\`), or reading a known region of a file (\`read_file\` with \`startLine\`).
Output: \`path:line:matched-line\` per hit, capped (default 200, max 1000). Use \`output_mode: "files_with_matches"\` to just get paths, or \`"count"\` for tallies.
Built-in ignores: \`.git\`, \`node_modules\`, \`dist\`, \`build\`, \`.next\`, \`target\`, \`__pycache__\`, \`.pnpm-store\`. Pass \`includeIgnored: true\` to see them.
Example: \`grep({ pattern: "function\\\\s+authenticate", type: "ts" })\` → all TS definitions of \`authenticate\`.`,

  glob: `When to use: finding files by name pattern ("all \`*.test.ts\` files", "the config file somewhere under \`packages/\`").
When NOT to use: searching file *contents* (\`grep\`), or listing one directory (\`ls\`).
Output: matching paths, sorted by mtime (most recent first). Caps at 500 by default.
Built-in ignores: same as \`grep\`. \`includeIgnored: true\` to disable.
Example: \`glob({ glob: "**/test_*.ts" })\` → every \`test_*.ts\` in the repo.`,

  ls: `When to use: a one-level directory listing (what's in this folder). Cheaper than \`glob\` for a single known directory.
When NOT to use: recursive discovery (\`glob\`), content search (\`grep\`).`,

  task: `When to use: open-ended exploration that would clutter your context ("find every callsite of X", "what does module Y do?"), or INDEPENDENT work streams you can fan out with \`tasks: [...]\` — they run in parallel.
When NOT to use: a single \`read_file\` or one-line \`grep\` (do it yourself), or serial work whose steps depend on each other.
Sub-agents get a FRESH context — they do not see your history, you do not see their intermediate steps, only their final structured conclusion. Write each objective so a fresh agent can act on it with no further context.
Types: \`explore\` (default, read-only) or \`worker\` (may edit + run bash). Sub-agents cannot spawn further sub-agents.
GOTCHA: parallel fan-out (\`tasks: [...]\`) runs via \`Promise.all\` — if one sub-agent hangs, all wait. Set \`maxSteps\` per task to bound it.
Example: \`task({ tasks: [{ objective: "find all callers of \`authenticate()\`", agent_type: "explore" }, { objective: "summarize the auth module's public API", agent_type: "explore" }] })\``,
  plan_update: `When to use: any non-trivial task (>= 3 steps, or touches > 1 file). The plan is a first-class output — surfaced to the user, survives compaction, anchors your work.
A good plan: 3-8 concrete steps, each with a stable \`id\`, one-line \`title\`, and \`status\` in {pending, in_progress, completed, blocked}.
Status discipline: exactly ONE \`in_progress\` at a time. Mark \`completed\` only when the deliverable is on disk AND verified. Mark \`blocked\` with the reason in the title.
Replan when reality changes — replace the plan, don't paper over it.`,

  ask_user_question: `When to use: a decision that genuinely changes your plan (scope choices, destructive confirmations, ambiguous requirements) — NOT for things you can decide from the codebase.
Ask at most a few questions at once (max 4). Each may carry choice options (put the recommended option first, labelled "(Recommended)"). Omit \`options\` for free-text.
GOTCHA: in headless sessions this tool errors — proceed with the most reasonable default and document the assumption.`,

  plan_done: `When to use: ONLY in \`plan\` mode, when the plan is complete and you are confident. The user approves or asks for revisions; on approval the session switches to \`agent\` mode.
The plan is written to \`.codepilot/plans/<slug>.md\` so it survives as a reviewable artifact. Don't call this before the plan is actually ready.`,

  web_fetch: `When to use: reading documentation, release notes, issues, API references.
When NOT to use: searching the web (\`web_search\`), or fetching URLs you cannot justify as relevant. Never fetch URLs constructed from untrusted data without inspecting them.
Output: HTTP status + final URL (if redirected) + readable text (HTML stripped). Large pages spill to an artifact. 30s timeout, 5MB cap, no credentials.
GOTCHA: no caching — every call re-fetches. If you need the same page twice, \`read_artifact\` the first result.`,

  web_search: `When to use: finding current information (library docs, error messages, current facts). Zero-dependency DuckDuckGo HTML scrape — best-effort, not a real search API.
When NOT to use: fetching a known URL (\`web_fetch\`), or anything you could find with \`grep\` in the repo.
GOTCHA: free-tier quality; for serious search, configure an MCP search server.`,

  memory_write: `When to use: capturing durable knowledge you discovered by reading the code or by trial and error — things a future session would benefit from. ("tests run with \`pnpm test\`", "the auth module is the source of truth for the user table").
When NOT to use: volatile knowledge (today's task, today's bug, today's plan). If it doesn't survive the session ending, don't persist it.
Scope: \`project\` (\`CODEPILOT.md\` in cwd) or \`user\` (\`~/.codepilot/MEMORY.md\`). Prefer project for repo-specific facts, user for cross-repo preferences.
Optional \`section\`: "Project context" / "Rules" / "Architecture decisions" / "Discovered durable knowledge". Without one, we classify by keywords.`,

  read_artifact: `When to use: pulling a slice of a large tool result that spilled to an artifact (bash output >8KB, web page, big file). The original tool result keeps the head + an \`art_<hash>\` ref; this tool reads the full content or a window.
GOTCHA: artifacts are session-scoped and may be evicted under memory pressure — if a ref is gone, re-run the source tool.`,

  skill: `When to use: loading a named skill's full instructions into context. The system prompt only advertises skill names + one-line descriptions; call this to get the body when the user's task matches a skill's \`when\` hint.
When NOT to use: speculative loading. Only pull a skill when you actually intend to follow it.`,
};
