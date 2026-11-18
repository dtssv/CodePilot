import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteBackward,
  deleteWordBackward,
  enterNormal,
  initialVim,
  insertText,
  sanitizeComposerText,
  verticalMove,
  vimNormalKey,
  wordBackward,
  wordEnd,
  wordForward,
  type EditState,
  type VimState,
} from "../src/ui/lineEditor.js";
import { editInExternalEditor, resolveEditor } from "../src/ui/externalEditor.js";
import { loadEditorMode, saveEditorMode } from "../src/ui/editorMode.js";
import { BUILTIN_COMMAND_NAMES, runCommand } from "../src/ui/commands.js";

const at = (value: string, cursor = value.length): EditState => ({ value, cursor });
const normalVim = (): VimState => ({ ...initialVim(), mode: "normal" });

/** Feed `keys` to normal mode one by one; returns the final state and vim. */
function vimKeys(s: EditState, keys: string, vim: VimState = normalVim()): { s: EditState; vim: VimState } {
  for (const k of keys) {
    const a = vimNormalKey(s, vim, k)!;
    vim = a.vim;
    if (a.kind === "edit") s = a.state;
  }
  return { s, vim };
}

describe("line editing", () => {
  it("inserts and deletes at the cursor, not the end", () => {
    expect(insertText(at("helo", 3), "l")).toEqual(at("hello", 4));
    expect(deleteBackward(at("hello", 2))).toEqual(at("hllo", 1));
    expect(deleteBackward(at("x", 0))).toEqual(at("x", 0));
  });

  it("sanitizes paste: CRLF → LF and strips clipboard ANSI", () => {
    expect(sanitizeComposerText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(sanitizeComposerText("\x1b[30mblack\x1b[0m")).toBe("black");
    expect(insertText(at(""), "hello\r\nworld")).toEqual(at("hello\nworld"));
    expect(insertText(at(""), "\x1b[30mpaste\x1b[39m")).toEqual(at("paste"));
  });

  it("moves and deletes by word", () => {
    expect(wordForward("foo bar.baz", 0)).toBe(4);
    expect(wordForward("foo bar.baz", 4)).toBe(7);
    expect(wordBackward("foo bar", 7)).toBe(4);
    expect(wordBackward("foo bar", 4)).toBe(0);
    expect(wordEnd("foo bar", 0)).toBe(2);
    expect(wordEnd("foo bar", 2)).toBe(6);
    expect(deleteWordBackward(at("git commit -m", 10))).toEqual(at("git  -m", 4));
  });

  it("moves between lines keeping the column, and reports the edges", () => {
    const s = at("abcd\nxy\nlonger", 3);
    expect(verticalMove(s, 1)).toBe(7);
    expect(verticalMove(at(s.value, 7), 1)).toBe(10);
    expect(verticalMove(s, -1)).toBeNull();
    expect(verticalMove(at(s.value, 10), 1)).toBeNull();
  });
});

describe("vim normal mode", () => {
  it("Esc steps back onto the last typed character", () => {
    const r = enterNormal(at("hello"), initialVim());
    expect(r.vim.mode).toBe("normal");
    expect(r.state.cursor).toBe(4);
  });

  it("supports motions with counts and 0 as line start", () => {
    expect(vimKeys(at("one two three four", 0), "2w").s.cursor).toBe(8);
    expect(vimKeys(at("one two", 5), "0").s.cursor).toBe(0);
    expect(vimKeys(at("  indented", 9), "^").s.cursor).toBe(2);
    expect(vimKeys(at("abc", 0), "$").s.cursor).toBe(2);
    expect(vimKeys(at("abc", 0), "10l").s.cursor).toBe(2);
  });

  it("deletes with operators and pastes from the register", () => {
    expect(vimKeys(at("foo bar baz", 4), "dw").s).toEqual(at("foo baz", 4));
    expect(vimKeys(at("foo bar baz", 0), "d2w").s.value).toBe("baz");
    expect(vimKeys(at("foo bar", 4), "D").s).toEqual(at("foo ", 3));
    expect(vimKeys(at("abc", 0), "xp").s.value).toBe("bac");
    const lines = vimKeys(at("one\ntwo\nthree", 5), "ddp");
    expect(lines.s.value).toBe("one\nthree\ntwo");
    expect(vimKeys(at("one\ntwo", 5), "dd").s).toEqual(at("one", 0));
  });

  it("change commands enter insert mode", () => {
    const cw = vimKeys(at("foo bar", 0), "cw");
    expect(cw.s).toEqual(at(" bar", 0));
    expect(cw.vim.mode).toBe("insert");
    expect(vimKeys(at("x", 0), "A").s.cursor).toBe(1);
    const o = vimKeys(at("a\nb", 0), "o");
    expect(o.s).toEqual(at("a\n\nb", 2));
    expect(vimKeys(at("abc", 1), "rX").s.value).toBe("aXc");
  });

  it("undoes edits with u", () => {
    const r = vimKeys(at("foo bar", 0), "dwx");
    expect(r.s.value).toBe("ar");
    expect(vimKeys(r.s, "u", r.vim).s.value).toBe("bar");
    expect(vimKeys(r.s, "uu", r.vim).s.value).toBe("foo bar");
  });

  it("j / k past the edges browse history; Enter submits", () => {
    expect(vimNormalKey(at("single", 0), normalVim(), "k")!.kind).toBe("history");
    expect(vimNormalKey(at("a\nb", 0), normalVim(), "j")!.kind).toBe("edit");
    expect(vimNormalKey(at("a", 0), normalVim(), "\r")!.kind).toBe("submit");
  });

  it("drops an unknown command without changing the text", () => {
    const r = vimKeys(at("abc", 1), "dz");
    expect(r.s).toEqual(at("abc", 1));
    expect(r.vim.pending).toBe("");
  });
});

describe("external editor", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prefers VISUAL, then EDITOR, then the platform default", () => {
    expect(resolveEditor({ VISUAL: "code --wait", EDITOR: "nano" })).toBe("code --wait");
    expect(resolveEditor({ EDITOR: "nano" })).toBe("nano");
    expect(resolveEditor({})).toBe(process.platform === "win32" ? "notepad" : "vi");
  });

  it.skipIf(process.platform === "win32")("round-trips the draft through the editor", () => {
    const d = mkdtempSync(join(tmpdir(), "cp-editor-"));
    dirs.push(d);
    const script = join(d, "fake-editor.cjs");
    writeFileSync(
      script,
      "const fs=require('fs');const f=process.argv[2];fs.writeFileSync(f,fs.readFileSync(f,'utf8').toUpperCase()+'\\n')",
    );
    const r = editInExternalEditor("draft text", { ...process.env, VISUAL: `"${process.execPath}" "${script}"` });
    expect(r).toEqual({ ok: true, text: "DRAFT TEXT" });
  });

  it.skipIf(process.platform === "win32")("reports a failing editor", () => {
    const r = editInExternalEditor("x", { ...process.env, VISUAL: "false" });
    expect(r.ok).toBe(false);
  });
});

describe("/vim", () => {
  const ctx = { controller: { kind: "mock" as const }, cwd: "/tmp" } as unknown as Parameters<typeof runCommand>[1];

  it("is a built-in that toggles or sets the mode", () => {
    expect(BUILTIN_COMMAND_NAMES.has("vim")).toBe(true);
    expect(runCommand("/vim", ctx)).toEqual({ kind: "set-vim" });
    expect(runCommand("/vim on", ctx)).toEqual({ kind: "set-vim", enabled: true });
    expect(runCommand("/vim off", ctx)).toEqual({ kind: "set-vim", enabled: false });
  });

  it("persists the choice", () => {
    const d = mkdtempSync(join(tmpdir(), "cp-editor-mode-"));
    try {
      const p = join(d, "nested", "tui-editor-mode");
      expect(loadEditorMode(p)).toBe("default");
      saveEditorMode("vim", p);
      expect(loadEditorMode(p)).toBe("vim");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
