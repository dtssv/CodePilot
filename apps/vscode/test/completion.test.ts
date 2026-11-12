import { describe, expect, it, vi } from "vitest";

import * as vscode from "vscode";
import { __setActiveTextEditor, __resetAll } from "./__mocks__/vscode.js";
import { CompletionProvider } from "../src/completion.js";

const { Position, Range, Selection, CancellationTokenSource } = vscode;
import type { CodepilotSettings } from "../src/config.js";
import type { Engine } from "../src/engine.js";

function settings(over: Partial<CodepilotSettings["completion"]> = {}): CodepilotSettings {
  return {
    completion: { enabled: true, debounceMs: 0, maxTokens: 96, ...over },
  } as CodepilotSettings;
}

/** A fake document: splits `text` at `cursor` offset into before/after. */
function doc(text: string, cursorOffset: number) {
  const lines = text.split("\n");
  const lineCount = lines.length;
  // Map a character offset to a {line, character} position for the cursor.
  let off = 0;
  let line = 0;
  let character = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cursorOffset <= off + lines[i]!.length) {
      line = i;
      character = cursorOffset - off;
      break;
    }
    off += lines[i]!.length + 1; // +1 for the newline
  }
  return {
    uri: { fsPath: "src/foo.ts" },
    lineCount,
    getText(range?: vscode.Range): string {
      if (!range) return text;
      const startOff = posToOffset(lines, range.start);
      const endOff = posToOffset(lines, range.end);
      return text.slice(startOff, endOff);
    },
    lineAt(n: number) {
      const l = lines[n] ?? "";
      return { range: { end: new Position(n, l.length) } };
    },
    __cursor: new Position(line, character),
  };
}

function posToOffset(lines: string[], pos: vscode.Position): number {
  let off = 0;
  for (let i = 0; i < pos.line; i++) off += lines[i]!.length + 1;
  return off + pos.character;
}

function fakeEngine(request: Engine["request"], notify: Engine["notify"] = vi.fn()): Engine {
  return { running: true, request, notify } as unknown as Engine;
}

describe("CompletionProvider", () => {
  it("returns undefined when disabled", async () => {
    __resetAll();
    const p = new CompletionProvider(
      fakeEngine(vi.fn()),
      () => settings({ enabled: false }),
      () => "/work",
      () => {},
    );
    const d = doc("const a = 1", 11);
    const res = await p.provideInlineCompletionItems(
      d as never,
      d.__cursor,
      {} as never,
      new CancellationTokenSource().token as never,
    );
    expect(res).toBeUndefined();
  });

  it("returns undefined on an empty prefix (nothing to continue)", async () => {
    __resetAll();
    const req = vi.fn();
    const p = new CompletionProvider(fakeEngine(req), () => settings(), () => "/work", () => {});
    const d = doc("", 0);
    const res = await p.provideInlineCompletionItems(
      d as never,
      d.__cursor,
      {} as never,
      new CancellationTokenSource().token as never,
    );
    expect(res).toBeUndefined();
    expect(req).not.toHaveBeenCalled();
  });

  it("skips when a selection is active", async () => {
    __resetAll();
    const req = vi.fn();
    __setActiveTextEditor({
      selection: new Selection(new Position(0, 0), new Position(0, 3)),
    });
    const p = new CompletionProvider(fakeEngine(req), () => settings(), () => "/work", () => {});
    const d = doc("abc", 3);
    const res = await p.provideInlineCompletionItems(
      d as never,
      d.__cursor,
      {} as never,
      new CancellationTokenSource().token as never,
    );
    expect(res).toBeUndefined();
    expect(req).not.toHaveBeenCalled();
  });

  it("calls the RPC and renders the completion as ghost text", async () => {
    __resetAll();
    const req = vi.fn().mockResolvedValue({ completion: "+ 1", requestId: "c1" });
    const p = new CompletionProvider(fakeEngine(req as never), () => settings(), () => "/work", () => {});
    const d = doc("const a = ", 10);
    const res = await p.provideInlineCompletionItems(
      d as never,
      d.__cursor,
      {} as never,
      new CancellationTokenSource().token as never,
    );
    expect(req).toHaveBeenCalledTimes(1);
    const args = req.mock.calls[0]!;
    expect(args[0]).toBe("completion/inline");
    expect(args[1]).toMatchObject({ prefix: "const a = ", path: "src/foo.ts" });
    expect(res).toHaveLength(1);
    expect(res![0].insertText).toBe("+ 1");
  });

  it("serves a repeated request from the client cache (no second RPC)", async () => {
    __resetAll();
    const req = vi.fn().mockResolvedValue({ completion: "x()", requestId: "c1" });
    const p = new CompletionProvider(fakeEngine(req as never), () => settings(), () => "/work", () => {});
    const d = doc("foo.", 4);
    const tok = () => new CancellationTokenSource().token as never;
    await p.provideInlineCompletionItems(d as never, d.__cursor, {} as never, tok());
    const res2 = await p.provideInlineCompletionItems(d as never, d.__cursor, {} as never, tok());
    expect(req).toHaveBeenCalledTimes(1); // cache hit, no round-trip
    expect(res2![0].insertText).toBe("x()");
  });

  it("surfaces the no-small-model notice once and renders nothing", async () => {
    __resetAll();
    const req = vi.fn().mockResolvedValue({ completion: "", requestId: "c1", disabledReason: "no-small-model" });
    const notify = vi.fn();
    const p = new CompletionProvider(fakeEngine(req as never), () => settings(), () => "/work", notify);
    const tok = () => new CancellationTokenSource().token as never;
    const r1 = await p.provideInlineCompletionItems(doc("a.", 2) as never, new Position(0, 2), {} as never, tok());
    const r2 = await p.provideInlineCompletionItems(doc("b.", 2) as never, new Position(0, 2), {} as never, tok());
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("returns undefined (no throw) when the RPC fails", async () => {
    __resetAll();
    const req = vi.fn().mockRejectedValue(new Error("timeout"));
    const p = new CompletionProvider(fakeEngine(req as never), () => settings(), () => "/work", () => {});
    const d = doc("const a = ", 10);
    const res = await p.provideInlineCompletionItems(
      d as never,
      d.__cursor,
      {} as never,
      new CancellationTokenSource().token as never,
    );
    expect(res).toBeUndefined();
  });

  it("tells the server to cancel when the request is superseded mid-flight", async () => {
    __resetAll();
    // An RPC that settles only when its abort signal fires (as the real engine
    // does), so the request rejects once the token is cancelled.
    const req = vi.fn().mockImplementation((_m: string, _p: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const s = opts?.signal;
        if (s) s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    const engineNotify = vi.fn();
    const p = new CompletionProvider(
      fakeEngine(req as never, engineNotify as never),
      () => settings(),
      () => "/work",
      () => {},
    );
    const d = doc("const a = ", 10);
    const src = new CancellationTokenSource();
    const resP = p.provideInlineCompletionItems(d as never, d.__cursor, {} as never, src.token as never);
    // Let the handler issue the RPC, then supersede it.
    await new Promise((r) => setTimeout(r, 0));
    src.cancel();
    await resP;
    expect(engineNotify).toHaveBeenCalledTimes(1);
    const [method, params] = engineNotify.mock.calls[0]!;
    expect(method).toBe("completion/cancel");
    expect(params).toMatchObject({ requestId: expect.any(String) });
    // The requestId matches the one sent on the inline request.
    const inlineReqId = (req.mock.calls[0]![1] as { requestId: string }).requestId;
    expect((params as { requestId: string }).requestId).toBe(inlineReqId);
  });
});
