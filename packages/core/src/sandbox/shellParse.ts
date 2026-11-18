// POSIX/bash command parser for permission decisions.
//
// Not an interpreter: it recovers the command boundaries and the programs a
// command line would run, which is what permission rules match against. It
// understands quoting, escapes, line continuations, comments, heredocs,
// subshells and brace groups, compound-command keywords, assignment prefixes,
// redirections, and recurses into `$(…)`, backticks, `<(…)`/`>(…)`, `${…}`,
// `sh -c '…'`, `eval …` and exec-style wrappers (`sudo`, `env`, `xargs`, …).
// Anything it cannot see through is reported as `opaque`.

export interface ShellParse {
  /** Top-level simple commands, raw source text (words + redirections). */
  segments: string[];
  /** Every command that may run: top-level, nested in substitutions, and the
   * program a wrapper (`sudo rm …`, `bash -c "rm …"`) would exec. Normalised
   * (quotes removed). Deny/ask rules match against these. */
  commands: string[];
  /** A substitution, a file-writing redirection or unbalanced quoting. */
  opaque: boolean;
}

interface Ctx {
  segments: string[];
  commands: Set<string>;
  opaque: boolean;
}

const MAX_DEPTH = 8;

export function parseShell(src: string): ShellParse {
  const ctx: Ctx = { segments: [], commands: new Set(), opaque: false };
  parseInto(src, ctx, 0, true);
  return { segments: ctx.segments, commands: [...ctx.commands], opaque: ctx.opaque };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "word"; raw: string }
  | { kind: "redir"; raw: string; op: string; target: string };

interface Heredoc {
  delim: string;
  stripTabs: boolean;
  expand: boolean;
}

/** Characters that end an unquoted word. */
const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

/** Redirection operators, longest first. */
const REDIR_OPS = ["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<&", "<>", "<<", ">", "<"];

/** Output-redirect targets that do not write a file. */
const HARMLESS_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|-|\d+)$/;

function parseInto(src: string, ctx: Ctx, depth: number, top: boolean): void {
  if (depth > MAX_DEPTH) {
    ctx.opaque = true;
    return;
  }
  let cmd: Token[] = [];
  const heredocs: Heredoc[] = [];
  const endCommand = (): void => {
    if (cmd.length > 0) emitCommand(cmd, ctx, depth, top);
    cmd = [];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      endCommand();
      i++;
      for (const h of heredocs.splice(0)) i = skipHeredoc(src, i, h, ctx, depth);
      continue;
    }
    // Process substitution `<(…)` / `>(…)` is a word, not a redirection.
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = matchParen(src, i + 2);
      parseInto(src.slice(i + 2, end), ctx, depth + 1, false);
      ctx.opaque = true;
      cmd.push({ kind: "word", raw: src.slice(i, Math.min(end + 1, src.length)) });
      if (end >= src.length) ctx.opaque = true;
      i = end + 1;
      continue;
    }
    const redirOp = matchRedirOp(src, i);
    if (redirOp) {
      // A leading all-digit word is the redirected fd (`2>`), not an argument.
      const prev = cmd[cmd.length - 1];
      let fd = "";
      if (prev?.kind === "word" && /^\d+$/.test(prev.raw) && !/\s/.test(src[i - 1] ?? " ")) {
        fd = prev.raw;
        cmd.pop();
      }
      let j = i + redirOp.length;
      while (src[j] === " " || src[j] === "\t") j++;
      const w = readWord(src, j, ctx, depth);
      const target = unquote(w.raw);
      cmd.push({ kind: "redir", raw: `${fd}${redirOp}${w.raw}`, op: redirOp, target });
      if (redirOp === "<<" || redirOp === "<<-") {
        heredocs.push({ delim: target, stripTabs: redirOp === "<<-", expand: !/['"\\]/.test(w.raw) });
      } else if (writesFile(redirOp, target)) {
        ctx.opaque = true;
      }
      i = w.end;
      continue;
    }
    const sep = matchSeparator(src, i);
    if (sep) {
      endCommand();
      i += sep;
      continue;
    }
    const w = readWord(src, i, ctx, depth);
    if (w.end === i) {
      i++; // defensive: never stall on an unexpected character
      continue;
    }
    cmd.push({ kind: "word", raw: w.raw });
    i = w.end;
  }
  endCommand();
  if (heredocs.length > 0) ctx.opaque = true; // heredoc never terminated
}

function matchRedirOp(src: string, i: number): string | null {
  const c = src[i];
  if (c !== "<" && c !== ">" && c !== "&") return null;
  for (const op of REDIR_OPS) if (src.startsWith(op, i)) return op;
  return null;
}

/** Length of the control operator at `i` (`&&`, `||`, `|&`, `;;`, `;&`, `|`, `&`, `;`, `(`, `)`), or 0. */
function matchSeparator(src: string, i: number): number {
  const two = src.slice(i, i + 2);
  if (two === "&&" || two === "||" || two === "|&" || two === ";;" || two === ";&") return 2;
  const c = src[i];
  return c === "|" || c === "&" || c === ";" || c === "(" || c === ")" ? 1 : 0;
}

function writesFile(op: string, target: string): boolean {
  if (op === "<" || op === "<&" || op === "<<<") return false;
  if (op === "<>") return true;
  return !HARMLESS_TARGET.test(target);
}

/** Skip a heredoc body starting at `i`; returns the index after its delimiter line. */
function skipHeredoc(src: string, i: number, h: Heredoc, ctx: Ctx, depth: number): number {
  const bodyStart = i;
  while (i < src.length) {
    let eol = src.indexOf("\n", i);
    if (eol === -1) eol = src.length;
    const line = src.slice(i, eol);
    if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delim) {
      if (h.expand) scanSubstitutions(src.slice(bodyStart, i), ctx, depth);
      return eol + 1;
    }
    i = eol + 1;
  }
  if (h.expand) scanSubstitutions(src.slice(bodyStart), ctx, depth);
  ctx.opaque = true;
  return src.length;
}

/** Find and parse `$(…)` / backtick substitutions inside expanding text (heredoc bodies). */
function scanSubstitutions(text: string, ctx: Ctx, depth: number): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const end = matchParen(text, i + 2);
      parseInto(text.slice(i + 2, end), ctx, depth + 1, false);
      ctx.opaque = true;
      i = end;
    } else if (c === "`") {
      const end = matchBacktick(text, i + 1);
      parseInto(text.slice(i + 1, end).replace(/\\`/g, "`"), ctx, depth + 1, false);
      ctx.opaque = true;
      i = end;
    }
  }
}

/**
 * Read one word starting at `i` (stops at unquoted whitespace/metachar).
 * Substitutions met on the way are parsed into `ctx` as nested commands.
 */
function readWord(src: string, i: number, ctx: Ctx, depth: number): { raw: string; end: number } {
  const start = i;
  while (i < src.length) {
    const c = src[i]!;
    if (META.has(c)) break;
    if (c === "\\") {
      if (src[i + 1] === "\n") break; // continuation ends the word
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        ctx.opaque = true;
        return { raw: src.slice(start), end: src.length };
      }
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = readDoubleQuoted(src, i + 1, ctx, depth);
      continue;
    }
    if (c === "$" || c === "`") {
      i = readDollarOrBacktick(src, i, ctx, depth);
      continue;
    }
    i++;
  }
  return { raw: src.slice(start, i), end: i };
}

/** From just after an opening `"`, return the index after the closing `"`. */
function readDoubleQuoted(src: string, i: number, ctx: Ctx, depth: number): number {
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "$" || c === "`") {
      i = readDollarOrBacktick(src, i, ctx, depth);
      continue;
    }
    i++;
  }
  ctx.opaque = true;
  return src.length;
}

/** Consume a `$…` expansion or a backtick substitution at `i`; returns the next index. */
function readDollarOrBacktick(src: string, i: number, ctx: Ctx, depth: number): number {
  if (src[i] === "`") {
    const end = matchBacktick(src, i + 1);
    parseInto(src.slice(i + 1, end).replace(/\\`/g, "`"), ctx, depth + 1, false);
    ctx.opaque = true;
    if (end >= src.length) return src.length;
    return end + 1;
  }
  const next = src[i + 1];
  if (next === "(") {
    if (src[i + 2] === "(") {
      // Arithmetic `$(( … ))`: no commands of its own, but may nest `$(…)`.
      const end = matchParen(src, i + 2);
      const inner = src.slice(i + 3, Math.max(i + 3, end - 1));
      if (/\$\(|`/.test(inner)) scanSubstitutions(inner, ctx, depth);
      return Math.min(end + 1, src.length);
    }
    const end = matchParen(src, i + 2);
    parseInto(src.slice(i + 2, end), ctx, depth + 1, false);
    ctx.opaque = true;
    return Math.min(end + 1, src.length);
  }
  if (next === "{") {
    const end = matchBrace(src, i + 2);
    const inner = src.slice(i + 2, end);
    if (/\$\(|`/.test(inner)) scanSubstitutions(inner, ctx, depth);
    if (end >= src.length) ctx.opaque = true;
    return Math.min(end + 1, src.length);
  }
  return i + 1;
}

/** Index of the `)` closing a paren opened just before `i` (src.length if none). */
function matchParen(src: string, i: number): number {
  let level = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return src.length;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = skipDoubleQuoted(src, i + 1);
      continue;
    }
    if (c === "`") {
      i = matchBacktick(src, i + 1) + 1;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]!))) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "(") level++;
    else if (c === ")" && --level === 0) return i;
    i++;
  }
  return src.length;
}

function skipDoubleQuoted(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "$" && src[i + 1] === "(") {
      i = matchParen(src, i + 2) + 1;
      continue;
    }
    if (c === "`") {
      i = matchBacktick(src, i + 1) + 1;
      continue;
    }
    i++;
  }
  return src.length;
}

function matchBacktick(src: string, i: number): number {
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i;
    i++;
  }
  return src.length;
}

function matchBrace(src: string, i: number): number {
  let level = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return src.length;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = skipDoubleQuoted(src, i + 1);
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      i = matchParen(src, i + 2) + 1;
      continue;
    }
    if (c === "{") level++;
    else if (c === "}" && --level === 0) return i;
    i++;
  }
  return src.length;
}

// ---------------------------------------------------------------------------
// Simple commands
// ---------------------------------------------------------------------------

/** Reserved words that may precede a command without being one. */
const PREFIX_KEYWORDS = new Set(["!", "{", "}", "then", "else", "elif", "do", "done", "fi", "esac", "if", "while", "until", "time"]);

/** Compound headers whose remaining words are data, not a command. */
const HEADER_KEYWORDS = new Set(["for", "select", "case", "function"]);

function emitCommand(tokens: Token[], ctx: Ctx, depth: number, top: boolean): void {
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k]!;
    if (t.kind !== "word" || !PREFIX_KEYWORDS.has(t.raw)) break;
    k++;
  }
  // `time -p cmd`
  if (tokens[k - 1]?.kind === "word" && (tokens[k - 1] as { raw: string }).raw === "time") {
    const t = tokens[k];
    if (t?.kind === "word" && t.raw === "-p") k++;
  }
  const rest = tokens.slice(k);
  const first = rest[0];
  if (!first || !rest.some((t) => t.kind === "word")) return;
  if (first.kind === "word" && HEADER_KEYWORDS.has(first.raw)) return;
  if (first.kind === "word" && first.raw.startsWith("((")) return; // arithmetic command / C-style for

  const text = rest.map((t) => t.raw).join(" ");
  if (top) ctx.segments.push(text);
  const argv = rest.filter((t): t is { kind: "word"; raw: string } => t.kind === "word").map((t) => t.raw);
  ctx.commands.add(text);
  expandCommand(argv, ctx, depth);
}

/** Add the normalised command and whatever program it execs to `ctx.commands`. */
function expandCommand(rawArgv: string[], ctx: Ctx, depth: number): void {
  let argv = rawArgv.map(unquote);
  for (let guard = 0; guard < 16 && argv.length > 0; guard++) {
    // Assignment prefix: `FOO=1 cmd`.
    let a = 0;
    while (a < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[a]!)) a++;
    argv = argv.slice(a);
    if (argv.length === 0) return;
    const prog = argv[0]!;
    ctx.commands.add(argv.join(" "));
    const base = prog.includes("/") ? prog.slice(prog.lastIndexOf("/") + 1) : prog;
    if (base !== prog && base) {
      argv = [base, ...argv.slice(1)];
      ctx.commands.add(argv.join(" "));
    }
    const inner = unwrap(base, argv.slice(1));
    if (inner === null) return;
    if (typeof inner === "string") {
      parseInto(inner, ctx, depth + 1, false);
      return;
    }
    argv = inner;
  }
}

/** Options taking a separate value, per wrapper. */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-D", "-R", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  exec: new Set(["-a"]),
  watch: new Set(["-n", "-d", "--interval"]),
  chrt: new Set([]),
  caffeinate: new Set(["-t", "-w"]),
};

const PLAIN_WRAPPERS = new Set(["command", "builtin", "nohup", "time", "unbuffer", "noglob"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/**
 * For a wrapper invocation, the argv it execs (array), a script string it
 * evaluates (string), or null when `prog` is not a wrapper.
 */
function unwrap(prog: string, args: string[]): string[] | string | null {
  if (prog === "eval") return args.join(" ");
  if (SHELLS.has(prog)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === "--") break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return args[k + 1] ?? "";
      if (!a.startsWith("-") && !a.startsWith("+")) break;
    }
    return null;
  }
  if (PLAIN_WRAPPERS.has(prog)) {
    let k = 0;
    while (k < args.length && args[k]!.startsWith("-")) k++;
    return args.slice(k);
  }
  const valueOpts = WRAPPER_VALUE_OPTS[prog];
  if (!valueOpts) return null;
  let k = 0;
  while (k < args.length) {
    const a = args[k]!;
    if (a === "--") {
      k++;
      break;
    }
    if (prog === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      k++;
      continue;
    }
    if (prog === "env" && (a === "-S" || a === "--split-string")) return args.slice(k + 1).join(" ");
    if (!a.startsWith("-") || a === "-") break;
    if (prog === "nice" && /^-\d+$/.test(a)) {
      k++;
      continue;
    }
    k += valueOpts.has(a) ? 2 : 1;
  }
  // timeout's first operand is the duration.
  if (prog === "timeout" && k < args.length) k++;
  return args.slice(k);
}

/** Remove shell quoting from one word (best-effort; expansions kept verbatim). */
export function unquote(w: string): string {
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (c === "\\") {
      if (i + 1 < w.length) out += w[++i];
      continue;
    }
    if (c === "'") {
      const end = w.indexOf("'", i + 1);
      if (end === -1) return out + w.slice(i + 1);
      out += w.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < w.length && w[j] !== '"') {
        if (w[j] === "\\" && j + 1 < w.length && '$`"\\\n'.includes(w[j + 1]!)) {
          out += w[j + 1];
          j += 2;
          continue;
        }
        if (w[j] === "$" && w[j + 1] === "(") {
          const end = matchParen(w, j + 2);
          out += w.slice(j, Math.min(end + 1, w.length));
          j = end + 1;
          continue;
        }
        out += w[j];
        j++;
      }
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}
