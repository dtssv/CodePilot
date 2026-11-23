import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/tools/atomicWrite.js";

describe("atomicWriteFile", () => {
  it("overwrites without leaving .tmp siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-atomic-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "old\n", "utf-8");
    await atomicWriteFile(p, "new\n", "utf-8");
    expect(readFileSync(p, "utf-8")).toBe("new\n");
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("creates a new file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-atomic-"));
    const p = join(dir, "fresh.txt");
    expect(existsSync(p)).toBe(false);
    await atomicWriteFile(p, "hi\n", "utf-8");
    expect(readFileSync(p, "utf-8")).toBe("hi\n");
  });
});
