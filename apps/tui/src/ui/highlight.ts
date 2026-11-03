/**
 * Lightweight, dependency-free syntax tokenizer for code blocks in the
 * terminal. A single generic tokenizer with per-language keyword sets covers
 * the languages that dominate agent output well enough for a CLI: comments,
 * strings, numbers, keywords and the odd operator get color; everything else
 * keeps the terminal's default foreground. Unknown languages tokenize with an
 * empty keyword set, so they still get string/number/comment coloring.
 *
 * This deliberately mirrors the web highlighter's role (apps/web/src/state/
 * highlighter.ts) but stays a tiny tokenizer: pulling a full grammar engine
 * into a terminal UI is not worth the weight.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword";

export interface Token {
  text: string;
  kind: TokenKind;
}

// Keyword sets per normalized language id. Small on purpose — enough to make
// code read as code, not an exhaustive grammar.
const KEYWORDS: Record<string, readonly string[]> = {
  javascript: [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "break", "continue", "class", "extends", "new", "this", "typeof", "instanceof",
    "import", "export", "from", "default", "async", "await", "yield", "try",
    "catch", "finally", "throw", "switch", "case", "delete", "in", "of", "void",
    "null", "undefined", "true", "false",
  ],
  typescript: [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "break", "continue", "class", "extends", "implements", "interface", "type",
    "enum", "new", "this", "typeof", "keyof", "instanceof", "import", "export",
    "from", "default", "async", "await", "yield", "try", "catch", "finally",
    "throw", "switch", "case", "public", "private", "protected", "readonly",
    "as", "in", "of", "void", "null", "undefined", "true", "false", "namespace",
  ],
  python: [
    "def", "return", "if", "elif", "else", "for", "while", "break", "continue",
    "class", "import", "from", "as", "try", "except", "finally", "raise", "with",
    "lambda", "yield", "async", "await", "pass", "global", "nonlocal", "del",
    "in", "is", "not", "and", "or", "None", "True", "False", "self",
  ],
  go: [
    "func", "return", "if", "else", "for", "range", "break", "continue", "var",
    "const", "type", "struct", "interface", "map", "chan", "go", "defer",
    "select", "switch", "case", "default", "package", "import", "nil", "true",
    "false", "make", "new",
  ],
  rust: [
    "fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "break",
    "continue", "match", "struct", "enum", "trait", "impl", "pub", "use", "mod",
    "crate", "self", "Self", "move", "async", "await", "dyn", "where", "as",
    "ref", "true", "false", "None", "Some", "Ok", "Err",
  ],
  java: [
    "public", "private", "protected", "class", "interface", "enum", "extends",
    "implements", "return", "if", "else", "for", "while", "do", "break",
    "continue", "new", "this", "super", "static", "final", "void", "import",
    "package", "try", "catch", "finally", "throw", "throws", "switch", "case",
    "null", "true", "false", "instanceof",
  ],
  kotlin: [
    "fun", "val", "var", "return", "if", "else", "for", "while", "when", "class",
    "object", "interface", "data", "sealed", "override", "open", "import",
    "package", "try", "catch", "finally", "throw", "is", "in", "as", "null",
    "true", "false", "this", "super", "companion",
  ],
  bash: [
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
    "esac", "function", "return", "export", "local", "in", "echo", "cd", "set",
  ],
  sql: [
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "JOIN", "LEFT", "RIGHT",
    "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AS",
    "AND", "OR", "NOT", "NULL", "DISTINCT", "COUNT", "SUM", "AVG",
  ],
  json: [],
  yaml: [],
  text: [],
};

const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", typescript: "typescript",
  javascript: "javascript",
  py: "python", python: "python",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  java: "java",
  kt: "kotlin", kotlin: "kotlin",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
  sql: "sql",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
};

function normalizeLang(lang: string | undefined): string {
  if (!lang) return "text";
  return ALIASES[lang.trim().toLowerCase()] ?? "text";
}

const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?/y;

// Line-comment prefixes per language (single string-start token set covers the
// common cases; block comments are treated line-by-line for simplicity).
const LINE_COMMENT: Record<string, string> = {
  javascript: "//", typescript: "//", go: "//", rust: "//", java: "//",
  kotlin: "//", python: "#", bash: "#", yaml: "#", sql: "--",
};

/** Tokenize one line of code. Multi-line strings are not tracked across lines. */
export function tokenizeLine(line: string, lang: string | undefined): Token[] {
  const id = normalizeLang(lang);
  const keywords = new Set(KEYWORDS[id] ?? []);
  const comment = LINE_COMMENT[id];
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const rest = line.slice(i);

    // Line comment → rest of the line.
    if (comment && rest.startsWith(comment)) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const ch = line[i];

    // Strings: ' " ` with simple escape handling, unterminated runs to EOL.
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      tokens.push({ text: line.slice(i, j), kind: "string" });
      i = j;
      continue;
    }

    // Numbers.
    NUMBER_RE.lastIndex = i;
    const numM = NUMBER_RE.exec(line);
    if (numM && numM.index === i && /[0-9]/.test(ch ?? "")) {
      tokens.push({ text: numM[0], kind: "number" });
      i += numM[0].length;
      continue;
    }

    // Identifiers / keywords.
    IDENT_RE.lastIndex = i;
    const idM = IDENT_RE.exec(line);
    if (idM && idM.index === i) {
      const word = idM[0];
      tokens.push({ text: word, kind: keywords.has(word) ? "keyword" : "plain" });
      i += word.length;
      continue;
    }

    // Everything else: accumulate a run of non-token characters as plain.
    let j = i + 1;
    while (
      j < n &&
      !/[A-Za-z_$0-9"'`]/.test(line[j] ?? "") &&
      !(comment && line.slice(j).startsWith(comment))
    ) {
      j++;
    }
    tokens.push({ text: line.slice(i, j), kind: "plain" });
    i = j;
  }

  return tokens;
}

/** True when `lang` maps to a grammar with highlighting worth applying. */
export function isHighlightable(lang: string | undefined): boolean {
  return normalizeLang(lang) !== "text";
}
