/**
 * Cursor-aware editing model for the composer, plus a vim normal-mode
 * interpreter. Pure functions over `{ value, cursor }` so InputBox stays a thin
 * key router and the behaviour is unit-testable without Ink.
 */

import { stripAnsi } from "./textWidth.js";

export interface EditState {
  value: string;
  /** Offset into `value`, 0..value.length. */
  cursor: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Normalize clipboard / paste chunks before they hit the composer. CRLF leaves
 * a bare `\r` that Ink emits mid-line (carriage return overwrites the row);
 * clipboard ANSI (e.g. black) would otherwise paint invisible text.
 */
export function sanitizeComposerText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", at - 1) + 1;
}

export function lineEnd(value: string, at: number): number {
  const nl = value.indexOf("\n", at);
  return nl === -1 ? value.length : nl;
}

export function insertText(s: EditState, text: string): EditState {
  const clean = sanitizeComposerText(text);
  return { value: s.value.slice(0, s.cursor) + clean + s.value.slice(s.cursor), cursor: s.cursor + clean.length };
}

export function deleteBackward(s: EditState): EditState {
  if (s.cursor === 0) return s;
  return { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
}

export function deleteRange(s: EditState, from: number, to: number): EditState {
  const a = clamp(Math.min(from, to), 0, s.value.length);
  const b = clamp(Math.max(from, to), 0, s.value.length);
  return { value: s.value.slice(0, a) + s.value.slice(b), cursor: a };
}

export function moveTo(s: EditState, cursor: number): EditState {
  return { value: s.value, cursor: clamp(cursor, 0, s.value.length) };
}

type CharClass = 0 | 1 | 2;
/** 0 = whitespace, 1 = word character, 2 = other punctuation (vim's `word`). */
function charClass(c: string | undefined): CharClass {
  if (c === undefined || /\s/.test(c)) return 0;
  return /[\p{L}\p{N}_]/u.test(c) ? 1 : 2;
}

/** Start of the next word (vim `w`). */
export function wordForward(value: string, at: number): number {
  let i = at;
  const cls = charClass(value[i]);
  if (cls !== 0) while (i < value.length && charClass(value[i]) === cls) i++;
  while (i < value.length && charClass(value[i]) === 0) i++;
  return i;
}

/** Start of the current or previous word (vim `b`). */
export function wordBackward(value: string, at: number): number {
  let i = at;
  while (i > 0 && charClass(value[i - 1]) === 0) i--;
  const cls = charClass(value[i - 1]);
  while (i > 0 && cls !== 0 && charClass(value[i - 1]) === cls) i--;
  return i;
}

/** Last character of the current or next word (vim `e`). */
export function wordEnd(value: string, at: number): number {
  let i = at + 1;
  while (i < value.length && charClass(value[i]) === 0) i++;
  const cls = charClass(value[i]);
  while (i + 1 < value.length && charClass(value[i + 1]) === cls && cls !== 0) i++;
  return Math.min(i, Math.max(0, value.length - 1));
}

/** Ctrl+W: delete the word before the cursor. */
export function deleteWordBackward(s: EditState): EditState {
  return deleteRange(s, wordBackward(s.value, s.cursor), s.cursor);
}

/** Same column on the previous (-1) / next (+1) line; null at the first / last line. */
export function verticalMove(s: EditState, dir: -1 | 1): number | null {
  const start = lineStart(s.value, s.cursor);
  const col = s.cursor - start;
  if (dir === -1) {
    if (start === 0) return null;
    const prevStart = lineStart(s.value, start - 1);
    return Math.min(prevStart + col, start - 1);
  }
  const end = lineEnd(s.value, s.cursor);
  if (end === s.value.length) return null;
  const nextStart = end + 1;
  return Math.min(nextStart + col, lineEnd(s.value, nextStart));
}

// ---------------------------------------------------------------------------
// vim normal mode
// ---------------------------------------------------------------------------

export type VimMode = "insert" | "normal";

export interface VimState {
  mode: VimMode;
  /** Keys typed so far for an incomplete command (count, operator, `r`, `g`). */
  pending: string;
  /** Unnamed register; `linewise` text pastes on its own line. */
  register: { text: string; linewise: boolean };
  /** Previous states for `u`, most recent last. */
  undo: EditState[];
}

export const initialVim = (): VimState => ({ mode: "insert", pending: "", register: { text: "", linewise: false }, undo: [] });

export type VimAction =
  | { kind: "edit"; state: EditState; vim: VimState }
  /** j / k past the first / last line — the composer browses history. */
  | { kind: "history"; dir: -1 | 1; vim: VimState }
  | { kind: "submit"; vim: VimState };

const UNDO_LIMIT = 100;

/** In normal mode the cursor sits on a character, never past the line's end. */
export function normalClamp(s: EditState): EditState {
  const start = lineStart(s.value, s.cursor);
  const end = lineEnd(s.value, s.cursor);
  return moveTo(s, end > start ? Math.min(s.cursor, end - 1) : start);
}

/** Esc from insert mode: vim steps the cursor back onto the last typed char. */
export function enterNormal(s: EditState, vim: VimState): { state: EditState; vim: VimState } {
  const start = lineStart(s.value, s.cursor);
  const state = normalClamp(moveTo(s, s.cursor > start ? s.cursor - 1 : s.cursor));
  return { state, vim: { ...vim, mode: "normal", pending: "" } };
}

/** Target of a motion key, or null if `key` is not a motion. */
function motion(s: EditState, key: string, count: number): number | null {
  let at = s.cursor;
  for (let n = 0; n < count; n++) {
    switch (key) {
      case "h":
        at = Math.max(lineStart(s.value, at), at - 1);
        break;
      case "l":
        at = Math.min(lineEnd(s.value, at), at + 1);
        break;
      case "w":
        at = wordForward(s.value, at);
        break;
      case "b":
        at = wordBackward(s.value, at);
        break;
      case "e":
        at = wordEnd(s.value, at);
        break;
      case "0":
        return lineStart(s.value, at);
      case "^": {
        let i = lineStart(s.value, at);
        while (i < lineEnd(s.value, at) && /\s/.test(s.value[i]!)) i++;
        return i;
      }
      case "$":
        return lineEnd(s.value, at);
      default:
        return null;
    }
  }
  return at;
}

/** Bounds of `count` whole lines starting at the cursor's line, including one newline. */
function lineSpan(value: string, at: number, count: number): { from: number; to: number } {
  const from = lineStart(value, at);
  let to = lineEnd(value, at);
  for (let n = 1; n < count && to < value.length; n++) to = lineEnd(value, to + 1);
  if (to < value.length) return { from, to: to + 1 };
  return { from: from > 0 ? from - 1 : from, to };
}

/** Interpret one key in normal mode. Returns null when the key is not handled. */
export function vimNormalKey(s: EditState, vim: VimState, key: string): VimAction | null {
  const seq = vim.pending + key;
  // [count][operator][count]command — a count never starts with 0, so a bare
  // `0` is the line-start motion.
  const m = /^([1-9]\d*)?([dcy]?)([1-9]\d*)?(.*)$/s.exec(seq)!;
  const c1 = m[1] ?? "";
  const op = m[2] ?? "";
  const c2 = m[3] ?? "";
  const rest = m[4] ?? "";
  if (rest === "") return { kind: "edit", state: s, vim: { ...vim, pending: seq } };
  const count = Math.max(1, Number(c1 || "1") * Number(c2 || "1"));
  const done = (state: EditState, patch: Partial<VimState> = {}, changed = state.value !== s.value): VimAction => ({
    kind: "edit",
    state,
    vim: {
      ...vim,
      pending: "",
      ...(changed ? { undo: [...vim.undo, s].slice(-UNDO_LIMIT) } : {}),
      ...patch,
    },
  });
  const insertMode: Partial<VimState> = { mode: "insert" };

  if (op !== "") {
    // dd / cc / yy: whole lines.
    if (rest === op) {
      const span = lineSpan(s.value, s.cursor, count);
      const text = s.value.slice(span.from, span.to);
      const register = { text: text.endsWith("\n") ? text : text.replace(/^\n/, "") + "\n", linewise: true };
      if (op === "y") return done(s, { register }, false);
      if (op === "c") {
        const ls = lineStart(s.value, s.cursor);
        let le = lineEnd(s.value, s.cursor);
        for (let n = 1; n < count && le < s.value.length; n++) le = lineEnd(s.value, le + 1);
        return done(deleteRange(s, ls, le), { register, ...insertMode });
      }
      const after = deleteRange(s, span.from, span.to);
      return done(normalClamp(moveTo(after, lineStart(after.value, after.cursor))), { register });
    }
    // `cw` changes to the end of the word, like `ce` (vim's special case).
    const motionKey = op === "c" && rest === "w" ? "e" : rest;
    let target = motion(s, motionKey, count);
    if (target === null) return done(s, {}, false);
    if (motionKey === "e") target += 1;
    const from = Math.min(s.cursor, target);
    const to = Math.max(s.cursor, target);
    const register = { text: s.value.slice(from, to), linewise: false };
    if (op === "y") return done(moveTo(s, from), { register }, false);
    const after = deleteRange(s, from, to);
    return done(op === "c" ? after : normalClamp(after), { register, ...(op === "c" ? insertMode : {}) });
  }

  if (rest.startsWith("r")) {
    if (rest.length < 2) return { kind: "edit", state: s, vim: { ...vim, pending: seq } };
    if (s.cursor >= lineEnd(s.value, s.cursor)) return done(s, {}, false);
    const ch = rest.slice(1);
    return done({ value: s.value.slice(0, s.cursor) + ch + s.value.slice(s.cursor + 1), cursor: s.cursor });
  }
  if (rest === "g") return { kind: "edit", state: s, vim: { ...vim, pending: seq } };

  const target = motion(s, rest, count);
  if (target !== null) return done(normalClamp(moveTo(s, target)), {}, false);

  const le = lineEnd(s.value, s.cursor);
  const ls = lineStart(s.value, s.cursor);
  switch (rest) {
    case "gg":
      return done(normalClamp(moveTo(s, 0)), {}, false);
    case "G":
      return done(normalClamp(moveTo(s, lineStart(s.value, s.value.length))), {}, false);
    case "j":
    case "k": {
      const dir = rest === "j" ? 1 : -1;
      const next = verticalMove(s, dir);
      if (next === null) return { kind: "history", dir, vim: { ...vim, pending: "" } };
      return done(normalClamp(moveTo(s, next)), {}, false);
    }
    case "i":
      return done(s, insertMode, false);
    case "a":
      return done(moveTo(s, Math.min(le, s.cursor + 1)), insertMode, false);
    case "I":
      return done(moveTo(s, motion(s, "^", 1)!), insertMode, false);
    case "A":
      return done(moveTo(s, le), insertMode, false);
    case "o":
      return done(insertText(moveTo(s, le), "\n"), insertMode);
    case "O":
      return done(moveTo(insertText(moveTo(s, ls), "\n"), ls), insertMode);
    case "x": {
      if (s.cursor >= le) return done(s, {}, false);
      const to = Math.min(le, s.cursor + count);
      return done(normalClamp(deleteRange(s, s.cursor, to)), {
        register: { text: s.value.slice(s.cursor, to), linewise: false },
      });
    }
    case "X": {
      const from = Math.max(ls, s.cursor - count);
      if (from === s.cursor) return done(s, {}, false);
      return done(deleteRange(s, from, s.cursor), { register: { text: s.value.slice(from, s.cursor), linewise: false } });
    }
    case "D":
    case "C": {
      const register = { text: s.value.slice(s.cursor, le), linewise: false };
      const after = deleteRange(s, s.cursor, le);
      return rest === "C" ? done(after, { register, ...insertMode }) : done(normalClamp(after), { register });
    }
    case "s":
      return done(deleteRange(s, s.cursor, Math.min(le, s.cursor + count)), insertMode);
    case "S":
      return done(deleteRange(s, ls, le), insertMode);
    case "p":
    case "P": {
      const { text, linewise } = vim.register;
      if (text === "") return done(s, {}, false);
      if (linewise) {
        const body = text.endsWith("\n") ? text.slice(0, -1) : text;
        if (rest === "p") {
          const at = lineEnd(s.value, s.cursor);
          return done(moveTo(insertText(moveTo(s, at), "\n" + body), at + 1));
        }
        return done(moveTo(insertText(moveTo(s, ls), body + "\n"), ls));
      }
      const at = rest === "p" && s.value.length > 0 ? Math.min(le, s.cursor + 1) : s.cursor;
      const after = insertText(moveTo(s, at), text);
      return done(normalClamp(moveTo(after, after.cursor - 1)));
    }
    case "u": {
      const prev = vim.undo[vim.undo.length - 1];
      if (!prev) return done(s, {}, false);
      return { kind: "edit", state: normalClamp(prev), vim: { ...vim, pending: "", undo: vim.undo.slice(0, -1) } };
    }
    case "\r":
    case "\n":
      return { kind: "submit", vim: { ...vim, pending: "" } };
    default:
      // Unknown command: drop the pending keys, like vim's bell.
      return done(s, {}, false);
  }
}
