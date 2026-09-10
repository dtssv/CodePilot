// Slash command system (claude-code-style custom commands).
//
// A "slash command" is a Markdown file with optional YAML frontmatter that
// becomes a user-invocable `/<name>` command. Typing `/name <args>` in the
// TUI loads the file's Markdown body as the next user prompt (with argument
// interpolation) and runs the agent loop from there — exactly as if the user
// had typed the body themselves.
//
// Discovery sources (highest priority first, first-definition-wins like
// skills):
//
//   1. <cwd>/.codepilot/commands/*.md       (project-local)
//   2. ~/.codepilot/commands/*.md           (user-global)
//
// File name (sans `.md`) becomes the command name. Names must be lowercase,
// may contain letters, digits, `-`, and `_`. Subdirectories are NOT scanned
// — only the top-level `commands/` folder (keeps the surface predictable).
//
// Frontmatter (all optional, deliberately claude-code-compatible):
//
//   ---
//   description: One-line summary shown in the / autocomplete menu.
//   argument-hint: <hint>            # e.g. "[issue-number]" — shown next to the name
//   allowed-tools: [bash, read_file] # pre-approve these tools for THIS turn
//                                     # (grant clears after the turn; claude-code semantics)
//   model: claude-sonnet-4-5         # override the model for THIS turn
//                                     # ("inherit" keeps the session model)
//   ---
//
// The body is a prompt template. These placeholders are interpolated:
//
//   $ARGUMENTS  → the full argument string the user typed after /name
//   $1, $2, …   → positional words from the arguments (1-indexed)
//   $$          → a literal `$`
//
// Unknown `$<word>` sequences are left untouched (so `$HOME` etc. survive).
//
// Built-in commands (/help, /model, /mode, /agent, /plan, /compact, /resume,
// /sessions, /goal, /clear, /exit) live in the TUI's commands.ts and are NOT
// shadowed by custom commands — a custom file with the same name is ignored
// and a warning is surfaced. This keeps the control surface stable.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered slash command. */
export interface SlashCommand {
  /** Command name (file name without `.md`). Lowercase, kebab/snake case. */
  name: string;
  /** One-line description for the autocomplete menu. */
  description: string;
  /** Optional argument hint, e.g. `<issue-number>`. */
  argumentHint?: string;
  /** Optional list of tool names to pre-approve for this turn only. */
  allowedTools?: string[];
  /** Optional model override for this turn ("inherit" keeps the session model). */
  model?: string;
  /** Absolute path to the .md file on disk. */
  path: string;
  /** Which source this command came from. */
  source: SlashCommandSource;
  /** Full markdown body (frontmatter stripped). Used as the prompt template. */
  body: string;
}

export type SlashCommandSource = "project" | "user";

export interface DiscoverSlashCommandsOptions {
  /** Override the project-local commands directory
   *  (defaults to `<cwd>/.codepilot/commands`). */
  projectDir?: string;
  /** Override the user-global commands directory
   *  (defaults to `~/.codepilot/commands`). */
  userDir?: string;
  /** Names that are reserved by built-in TUI commands and cannot be
   *  overridden by custom files. Files matching a reserved name are
   *  skipped (with a warning surfaced via `loadWarnings`). Defaults to
   *  the empty set — the TUI populates this. */
  reservedNames?: ReadonlySet<string>;
}

export interface DiscoverSlashCommandsResult {
  commands: SlashCommand[];
  /** Non-fatal issues encountered during discovery (bad name, reserved
   *  collision, unreadable file). Hosts may surface these once. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parser (mirrors skills.ts — minimal, zero deps)
// ---------------------------------------------------------------------------

export interface SlashCommandFrontmatter {
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
}

/**
 * Parse a command .md file's frontmatter. Recognised keys:
 * `description`, `argument-hint`, `allowed-tools`, `model`. Everything
 * else is silently ignored. Lists accept YAML flow (`[a, b]`) or repeated
 * `- item` lines. `allowed-tools` may also be a comma/space-separated
 * string (claude-code accepts that form).
 */
export function parseSlashCommandMd(text: string): SlashCommandFrontmatter {
  const out: SlashCommandFrontmatter = {};
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return out;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return out;

  const fmLines = lines.slice(1, end);
  let currentKey: string | null = null;
  for (const raw of fmLines) {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0) continue;
    // Continuation lines (indented) — list items under the current key.
    if (/^\s/.test(line) && currentKey) {
      const trimmed = line.trim();
      if (currentKey === "allowed-tools") {
        if (trimmed.startsWith("- ")) {
          out.allowedTools = out.allowedTools ?? [];
          out.allowedTools.push(stripQuotes(trimmed.slice(2).trim()));
        }
      }
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    currentKey = key;
    if (value.length === 0) continue; // list starts on next line
    if (key === "description") out.description = stripQuotes(value);
    else if (key === "argument-hint") out.argumentHint = stripQuotes(value);
    else if (key === "model") out.model = stripQuotes(value);
    else if (key === "allowed-tools") {
      // Flow list `[a, b, c]`, comma/space-separated bare string, or single value.
      const flow = value.match(/^\[(.*)\]$/);
      if (flow) {
        out.allowedTools = flow[1]!
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
      } else if (/[,\s]/.test(value)) {
        // comma- or space-separated string (claude-code accepts "Bash Read Grep")
        out.allowedTools = value
          .split(/[,\s]+/)
          .map((s) => stripQuotes(s))
          .filter((s) => s.length > 0);
      } else {
        out.allowedTools = [stripQuotes(value)];
      }
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/** A command name must be lowercase ASCII letters/digits/-/_ and 1–64 chars.
 *  Mirrors claude-code's constraints. */
export function isValidCommandName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Scan a single `commands/` directory for `*.md` files. Returns the parsed
 *  commands plus any non-fatal warnings. Missing directories are not an
 *  error — they return `[]`. */
async function scanDirForCommands(
  dir: string,
  source: SlashCommandSource,
  reserved: ReadonlySet<string>
): Promise<{ commands: SlashCommand[]; warnings: string[] }> {
  const commands: SlashCommand[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { commands, warnings };
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { commands, warnings };
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // Validate the RAW filename (before lowercasing). claude-code requires
    // lowercase command names; a file named `Review.md` would otherwise
    // silently become `/review`, which is surprising. Reject mixed case.
    const rawName = basename(entry, ".md");
    if (!isValidCommandName(rawName)) {
      warnings.push(
        `Skipping "${entry}": command name must be lowercase and match /^[a-z0-9][a-z0-9_-]{0,63}$/`
      );
      continue;
    }
    const name = rawName.toLowerCase();
    if (reserved.has(name)) {
      warnings.push(
        `Skipping "${entry}": name "${name}" is reserved by a built-in command.`
      );
      continue;
    }
    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch (err) {
      warnings.push(`Could not read "${entry}": ${(err as Error).message}`);
      continue;
    }
    const fm = parseSlashCommandMd(text);
    const body = stripFrontmatter(text);
    commands.push({
      name,
      description: fm.description ?? firstParagraph(body),
      argumentHint: fm.argumentHint,
      allowedTools: fm.allowedTools,
      model: fm.model,
      path: filePath,
      source,
      body,
    });
  }
  return { commands, warnings };
}

/** Discover slash commands from project-local then user-global sources.
 *  Project commands win on name collisions (first-definition-wins, same as
 *  skills). The `reservedNames` set blocks custom files from shadowing
 *  built-in TUI commands. */
export async function discoverSlashCommands(
  cwd: string,
  opts: DiscoverSlashCommandsOptions = {}
): Promise<DiscoverSlashCommandsResult> {
  const projectDir = opts.projectDir ?? join(cwd, ".codepilot", "commands");
  const userDir = opts.userDir ?? join(homedir(), ".codepilot", "commands");
  const reserved = opts.reservedNames ?? new Set<string>();

  const collected: SlashCommand[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const add = (c: SlashCommand) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    collected.push(c);
  };

  const project = await scanDirForCommands(projectDir, "project", reserved);
  for (const c of project.commands) add(c);
  warnings.push(...project.warnings);
  const user = await scanDirForCommands(userDir, "user", reserved);
  for (const c of user.commands) add(c);
  warnings.push(...user.warnings);

  // Stable order: by source priority (project first), then alphabetically.
  const priority: Record<SlashCommandSource, number> = { project: 0, user: 1 };
  collected.sort((a, b) => {
    const pa = priority[a.source] - priority[b.source];
    if (pa !== 0) return pa;
    return a.name.localeCompare(b.name);
  });
  return { commands: collected, warnings };
}

// ---------------------------------------------------------------------------
// Lookup + rendering
// ---------------------------------------------------------------------------

/** Find a command by exact name (case-insensitive). */
export function findSlashCommand(
  commands: readonly SlashCommand[],
  name: string
): SlashCommand | null {
  const lower = name.toLowerCase();
  for (const c of commands) {
    if (c.name === lower) return c;
  }
  for (const c of commands) {
    if (c.name.toLowerCase() === lower) return c;
  }
  return null;
}

/** Render the autocomplete/help listing line for a command. */
export function commandHelpLine(c: SlashCommand): string {
  const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
  const desc = c.description ? ` — ${c.description}` : "";
  return `/${c.name}${hint}${desc}`;
}

// ---------------------------------------------------------------------------
// Prompt-template interpolation
// ---------------------------------------------------------------------------

/**
 * Render the command body into the final user prompt by interpolating
 * `$ARGUMENTS`, `$1`, `$2`, … and `$$`. Unknown `$<word>` sequences are
 * left untouched so environment-style refs survive.
 *
 * Positional args split on whitespace (1-indexed: `$1` is the first word).
 * `$ARGUMENTS` is the raw string after the command name (trimmed but
 * otherwise unmodified — quotes are preserved).
 */
export function renderCommandPrompt(
  command: SlashCommand,
  args: string
): string {
  const trimmed = args.trim();
  const words = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  return interpolateTemplate(command.body, trimmed, words);
}

/** Lower-level interpolator exposed for testing. */
export function interpolateTemplate(
  template: string,
  args: string,
  words: string[]
): string {
  // Single pass. We scan for `$` and decide based on the following char.
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch !== "$") {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    // $$ → literal $
    if (next === "$") {
      out += "$";
      i++;
      continue;
    }
    // $ARGUMENTS (case-insensitive, word boundary)
    if (next && /[Aa]/.test(next) && template.slice(i + 1).match(/^ARGUMENTS\b/i)) {
      out += args;
      i += "ARGUMENTS".length;
      continue;
    }
    // $<digits> → positional word (1-indexed). `$0` is the whole arg string.
    if (next && /[0-9]/.test(next)) {
      let j = i + 1;
      let numStr = "";
      while (j < template.length && /[0-9]/.test(template[j]!)) {
        numStr += template[j];
        j++;
      }
      const num = parseInt(numStr, 10);
      if (num === 0) {
        out += args;
      } else {
        const w = words[num - 1];
        out += w ?? "";
      }
      i = j - 1;
      continue;
    }
    // Unknown $ sequence — leave as-is.
    out += "$";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Take the first non-empty paragraph of the body as a fallback description. */
function firstParagraph(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  // First paragraph = up to the first blank line.
  const para = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  // Collapse internal newlines + whitespace for a single-line summary.
  return para.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Resolve a possibly-relative directory against `cwd`. */
export function resolveCommandsDir(cwd: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

// Re-export path helpers for hosts that want to create commands programmatically.
export function commandsDirFor(cwd: string): string {
  return join(cwd, ".codepilot", "commands");
}

export function userCommandsDir(): string {
  return join(homedir(), ".codepilot", "commands");
}

/** Where the body file for a *given* command would live — useful for
 *  programmatic writers / test scaffolding. */
export function commandFilePath(commandsDir: string, name: string): string {
  return join(commandsDir, `${name}.md`);
}

/** Return the directory holding a discovered command's file. */
export function commandDir(command: SlashCommand): string {
  return dirname(command.path);
}

// ---------------------------------------------------------------------------
// Top-level convenience: parse + resolve + render in one shot
// ---------------------------------------------------------------------------

/** Result of resolving a raw `/name args` input against a command set. */
export type ResolveResult =
  | { ok: true; command: SlashCommand; args: string; prompt: string }
  | { ok: false; reason: "not-a-command" }
  | { ok: false; reason: "not-found"; name: string }
  | {
      ok: false;
      reason: "no-args";
      command: SlashCommand;
      message: string;
    };

/**
 * Resolve a raw user input string against a set of discovered commands.
 *
 * - Input not starting with `/` → `{ ok: false, reason: "not-a-command" }`.
 * - `/name args...`: looks up `name`. Unknown → `not-found`. Found → renders
 *   the prompt and returns it. If the command declares `argument-hint` (i.e.
 *   expects args) and none were given, returns `no-args` with a usage hint so
 *   the host can surface "Usage: /name <hint>" instead of sending an empty
 *   prompt.
 *
 * Note: this does NOT touch built-in commands — the caller is expected to
 * have already checked `isCommand` + the built-in dispatch table. This
 * function only handles custom commands discovered from disk.
 */
export function resolveSlashCommand(
  input: string,
  commands: readonly SlashCommand[]
): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { ok: false, reason: "not-a-command" };
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0]?.toLowerCase() ?? "";
  const args = parts.slice(1).join(" ").trim();
  const command = findSlashCommand(commands, name);
  if (!command) return { ok: false, reason: "not-found", name };
  // If the command advertises an argument hint and no args were given, hint.
  if (command.argumentHint && args.length === 0) {
    return {
      ok: false,
      reason: "no-args",
      command,
      message: `Usage: /${command.name} ${command.argumentHint}`,
    };
  }
  const prompt = renderCommandPrompt(command, args);
  return { ok: true, command, args, prompt };
}
