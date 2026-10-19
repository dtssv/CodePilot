// Shell command structure for permission decisions.
//
// Permission rules like `bash(cat *)` are prefix globs over the whole command
// string, so on their own they also match `cat a && rm -rf x`. The helpers
// here split a command into the simple commands it runs, so rules and the
// read-only allowlist can be applied to each one, and flag constructs whose
// effect cannot be judged from the text (command substitution, file writes
// through redirection).

export interface ParsedCommand {
 /** The simple commands, split on `&&`, `||`, `;`, `|`, `&` and newlines. */
  segments: string[];
 /** Command/process substitution or a redirection that writes a file. */
  opaque: boolean;
}

/** Redirections that do not write a file: to /dev/null or fd duplication. */
const HARMLESS_REDIRECT = /^(?:&?>>?\s*\/dev\/null\b|>&\d)/;

export function parseCommand(command: string): ParsedCommand {
  const segments: string[] = [];
  let opaque = false;
  let cur = "";
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    const s = cur.trim();
    if (s) segments.push(s);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (next ?? "");
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) opaque = true;
    if (quote === '"') {
      cur += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") opaque = true;
    if (c === ">" || (c === "&" && next === ">")) {
      const m = command.slice(i).match(HARMLESS_REDIRECT);
      if (!m) {
        opaque = true;
      } else {
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      flush();
      if ((c === "|" || c === "&") && next === c) i++;
      continue;
    }
    cur += c;
  }
  if (quote) opaque = true;
  flush();
  return { segments, opaque };
}

/** Programs that only read state, whatever their arguments (barring the
 * per-program exceptions in {@link isReadOnlySegment}). */
const READ_ONLY_PROGRAMS = new Set([
  "cat", "head", "tail", "less", "wc", "nl", "ls", "tree", "pwd", "cd", "echo", "printf",
  "rg", "grep", "egrep", "fgrep", "ag", "find", "fd", "which", "type", "whoami", "id",
  "file", "stat", "du", "df", "sort", "uniq", "cut", "tr", "column", "comm", "diff", "cmp",
  "basename", "dirname", "realpath", "readlink", "date", "uname", "hostname", "uptime",
  "true", "false", "test", "[", "jq", "md5", "md5sum", "shasum", "sha1sum", "sha256sum",
  "ps", "lsof", "sed",
]);

const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe",
  "shortlog", "cat-file", "grep", "reflog", "merge-base", "rev-list", "name-rev",
]);

function words(segment: string): string[] {
  return segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? [];
}

function unquote(w: string): string {
  return w.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** Whether one simple command only reads. */
export function isReadOnlySegment(segment: string): boolean {
  const argv = words(segment).map(unquote);
  const prog = argv[0];
 // `FOO=bar cmd` can change what `cmd` does (PATH, LD_PRELOAD, …).
  if (!prog || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prog)) return false;
  const args = argv.slice(1);
  if (prog === "git") {
    const sub = args[0];
    if (!sub) return false;
    if (GIT_READ_ONLY.has(sub)) return !args.some((a) => a.startsWith("--output") || a === "--ext-diff");
    if (sub === "branch") return args.slice(1).every((a) => /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--merged|--no-merged|--contains)$/.test(a));
    if (sub === "remote") return args.slice(1).every((a) => a === "-v" || a === "show" || a === "get-url" || !a.startsWith("-"));
    if (sub === "stash") return args[1] === "list" || args[1] === "show";
    if (sub === "tag") return args.length === 1 || args.slice(1).every((a) => a === "-l" || a === "--list" || !a.startsWith("-"));
    return false;
  }
  if (!READ_ONLY_PROGRAMS.has(prog)) return false;
  switch (prog) {
    case "find":
      return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
    case "fd":
      return !args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec"));
    case "sort":
    case "tree":
      return !args.some((a) => a === "-o" || a.startsWith("--output"));
    case "sed":
 // Only the `sed -n '<range>p'` read idiom; sed scripts can write (`w`)
 // or execute (`e`), and -i edits in place.
      return args[0] === "-n" && /^[\d,$]+p$/.test(args[1] ?? "") && !args.some((a) => a.startsWith("-i"));
    case "rg":
      return !args.some((a) => a === "--pre" || a.startsWith("--pre="));
    default:
      return true;
  }
}

/** Every simple command in `command` only reads, and nothing is hidden in a
 * substitution or written through a redirection. */
export function isReadOnlyCommand(command: string): boolean {
  const { segments, opaque } = parseCommand(command);
  return !opaque && segments.length > 0 && segments.every(isReadOnlySegment);
}
