import { describe, expect, it } from "vitest";
import { acceptSave, canSave, changedExternally, type EditorFile } from "../src/state/workspaceEditor.js";

const file: EditorFile = {
  path: "a.ts", content: "edited", original: "before", size: 6,
  hash: "old", originalHash: "old", truncated: false,
};

describe("workspace editor save baseline", () => {
  it("updates both hashes and content baseline after saving", () => {
    const saved = acceptSave(file, { hash: "new", size: 6 });
    expect(saved).toMatchObject({ hash: "new", originalHash: "new", original: "edited", size: 6 });
    expect(changedExternally(saved, { exists: true, hash: "new" })).toBe(false);
    expect(canSave(saved, false, false)).toBe(false);
    expect(file.originalHash).toBe("old");
  });

  it("supports another edit after the first successful save", () => {
    const saved = acceptSave(file, { hash: "new", size: 6 });
    const edited = { ...saved, content: "second edit" };
    expect(canSave(edited, false, false)).toBe(true);
    expect(edited.originalHash).toBe("new");
  });

  it("treats deletion and same-size content changes as conflicts", () => {
    expect(changedExternally(file, { exists: false, hash: "" })).toBe(true);
    expect(changedExternally(file, { exists: true, hash: "different" })).toBe(true);
    expect(changedExternally(file, { exists: true, hash: "old" })).toBe(false);
  });

  it("never saves truncated content, active saves, conflicts or unmodified buffers", () => {
    expect(canSave({ ...file, truncated: true }, false, false)).toBe(false);
    expect(canSave(file, true, false)).toBe(false);
    expect(canSave(file, false, true)).toBe(false);
    expect(canSave({ ...file, content: file.original! }, false, false)).toBe(false);
    expect(canSave(file, false, false)).toBe(true);
  });
});
