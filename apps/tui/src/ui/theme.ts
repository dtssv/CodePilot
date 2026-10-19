/**
 * Terminal palette and vocabulary, shared by every TUI component.
 *
 * Colors mirror the web/desktop/IDE design tokens (apps/web/src/index.css)
 * so the CLI reads as the same product. Body text keeps the terminal's own
 * foreground: a fixed light ink would vanish on light terminal themes.
 */

export const color = {
  accent: "#8b7cff",
  accentStrong: "#6d5bf6",
  info: "#4ba3ff",
  add: "#3fb97f",
  remove: "#f0616d",
  warn: "#e8b04a",
  faint: "#6b7386",
  edge: "#2a3142",
} as const;

/** Brand gradient stops (logo mark, header). */
export const brand = ["#8b7cff", "#5b8dff", "#3fc6ff"] as const;

export const glyph = {
  logo: "✦",
  user: "›",
  assistant: "◆",
  ok: "✓",
  fail: "✗",
  running: "●",
  pending: "○",
  active: "◐",
  retry: "↻",
  compact: "⟳",
  warn: "▲",
  dot: "·",
  arrow: "→",
  bar: "│",
} as const;

export type ToolCategory =
  | "read" | "list" | "search" | "edit" | "write" | "bash"
  | "web" | "task" | "memory" | "plan" | "ask" | "other";

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read_file: "read", read: "read", read_artifact: "read", view: "read", read_image: "read",
  list_dir: "list", ls: "list",
  glob: "search", grep: "search", search: "search", code_search: "search", semantic_search: "search",
  edit_file: "edit", edit: "edit", multi_edit: "edit", apply_patch: "edit", str_replace: "edit", notebook_edit: "edit",
  write_file: "write", write: "write", create_file: "write",
  bash: "bash", bash_output: "bash", bash_kill: "bash", write_stdin: "bash", shell: "bash", run_command: "bash",
  web_fetch: "web", fetch: "web", web_search: "web",
  task: "task", spawn_agent: "task", team: "task", skill: "task",
  memory_write: "memory", remember: "memory", memory: "memory",
  plan_update: "plan", todo_write: "plan", update_plan: "plan",
  ask_user_question: "ask", plan_done: "ask",
};

export function toolCategory(name: string): ToolCategory {
  const direct = CATEGORY_BY_NAME[name];
  if (direct) return direct;
  const n = name.toLowerCase();
  if (n.includes("read")) return "read";
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return "search";
  if (n.includes("edit") || n.includes("patch") || n.includes("replace")) return "edit";
  if (n.includes("write") || n.includes("create")) return "write";
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "bash";
  if (n.includes("web") || n.includes("fetch") || n.includes("http")) return "web";
  if (n.includes("memory")) return "memory";
  if (n.includes("agent") || n.includes("task")) return "task";
  return "other";
}

/** Step verbs, identical to the web UI's. */
export const CATEGORY_VERB: Record<ToolCategory, string> = {
  read: "Read",
  list: "Listed",
  search: "Searched",
  edit: "Edited",
  write: "Wrote",
  bash: "Ran",
  web: "Fetched",
  task: "Delegated",
  memory: "Saved memory",
  plan: "Updated plan",
  ask: "Asked you",
  other: "Called",
};

/** Present-tense verbs for the activity line while a step runs. */
export const CATEGORY_ACTIVE: Record<ToolCategory, string> = {
  read: "Reading",
  list: "Listing",
  search: "Searching",
  edit: "Editing",
  write: "Writing",
  bash: "Running",
  web: "Fetching",
  task: "Delegating",
  memory: "Saving memory",
  plan: "Planning",
  ask: "Waiting for you",
  other: "Calling",
};

/** The one-line target of a tool call: path, command, pattern, url… */
export function toolTarget(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return oneLine(String(input), 120);
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "objective", "description", "ref"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return oneLine(v, 120);
  }
  return "";
}

/** Lines added/removed by an edit or write, from its input. */
export function changeCounts(name: string, input: unknown): { added: number; removed: number } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const lines = (v: unknown): number => (typeof v === "string" && v !== "" ? v.replace(/\n$/, "").split("\n").length : 0);
  const cat = toolCategory(name);
  if (cat === "write" && typeof o.content === "string") return { added: lines(o.content), removed: 0 };
  if (cat === "edit") {
    const before = o.search ?? o.old_string ?? o.old_str;
    const after = o.replace ?? o.new_string ?? o.new_str;
    if (typeof before === "string" || typeof after === "string") return { added: lines(after), removed: lines(before) };
  }
  return undefined;
}

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `~/…` for paths under home. */
export function shortPath(p: string, home = process.env.HOME ?? ""): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}
