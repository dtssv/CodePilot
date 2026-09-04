import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemory,
  renderMemory,
  classifySection,
  summariseMemoryText,
  FileMemorySink,
  MEMORY_SECTIONS,
} from "../src/memory.js";

describe("parseMemory", () => {
  it("returns empty sections for empty input", () => {
    const p = parseMemory("");
    for (const s of MEMORY_SECTIONS) {
      expect(p.sections[s]).toBe("");
    }
    expect(p.unstructured).toBe(false);
  });

  it("treats an unheaded file as Project context (unstructured)", () => {
    const p = parseMemory("just some prose, no headers");
    expect(p.sections["Project context"]).toContain("just some prose");
    expect(p.unstructured).toBe(true);
  });

  it("extracts all four canonical sections", () => {
    const md = [
      "## Project context",
      "",
      "A toy project.",
      "",
      "## Rules",
      "",
      "- no try/catch",
      "",
      "## Architecture decisions",
      "",
      "chose bun over node",
      "",
      "## Discovered durable knowledge",
      "",
      "Bun's Read has no native tail-N",
    ].join("\n");
    const p = parseMemory(md);
    expect(p.sections["Project context"]).toContain("toy project");
    expect(p.sections["Rules"]).toContain("no try/catch");
    expect(p.sections["Architecture decisions"]).toContain("chose bun");
    expect(p.sections["Discovered durable knowledge"]).toContain("Bun's Read");
  });

  it("preserves extra headings as extras", () => {
    const p = parseMemory("## Misc\n\nstuff\n");
    expect(p.extras.find((e) => e.title === "Misc")?.body).toBe("stuff");
  });
});

describe("renderMemory", () => {
  it("writes the four canonical sections in order, even when empty", () => {
    const text = renderMemory({
      sections: {
        "Project context": "",
        "Rules": "",
        "Architecture decisions": "",
        "Discovered durable knowledge": "",
      },
      extras: [],
      unstructured: false,
      raw: "",
    });
    for (const s of MEMORY_SECTIONS) {
      expect(text).toContain(`## ${s}`);
    }
  });
});

describe("classifySection", () => {
  it("picks Rules when content mentions a hard constraint", () => {
    expect(classifySection("Note", "you must never commit without sign-off")).toBe("Rules");
  });
  it("picks Architecture decisions when content mentions a choice", () => {
    expect(classifySection("Note", "we chose bun over node")).toBe("Architecture decisions");
  });
  it("falls back to Project context", () => {
    expect(classifySection("Note", "we are a small team")).toBe("Project context");
  });
});

describe("summariseMemoryText", () => {
  it("uses section-aware truncation for >200-line files", () => {
    const lines: string[] = ["## Project context", ""];
    for (let i = 0; i < 250; i++) lines.push(`line ${i} of project context`);
    lines.push("", "## Rules", "");
    for (let i = 0; i < 250; i++) lines.push(`rule ${i}`);
    const out = summariseMemoryText(lines.join("\n"), 2000);
    expect(out).toContain("## Project context");
    expect(out).toContain("## Rules");
    expect(out).toContain("truncated");
  });

  it("uses a simple prefix for small files", () => {
    const md = "a".repeat(5000);
    const out = summariseMemoryText(md, 100);
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("truncated");
  });
});

describe("FileMemorySink with sections", () => {
  let dir: string;
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  // mkdtemp is sync; do it inline per test.
  const make = () => {
    cleanup();
    dir = mkdtempSync(join(tmpdir(), "mem-"));
    return dir;
  };

  it("writes into the requested section", async () => {
    const d = make();
    const sink = new FileMemorySink(d);
    const target = await sink.write("project", "Always lint", "no commit without lint", "Rules");
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("## Rules");
    expect(text).toContain("no commit without lint");
    expect(text).toContain("## Project context"); // still rendered for completeness
  });

  it("classifies when no section given", async () => {
    const d = make();
    const sink = new FileMemorySink(d);
    const target = await sink.write("project", "X", "we chose bun over node");
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("## Architecture decisions");
  });

  it("appends multiple entries under the same section", async () => {
    const d = make();
    const sink = new FileMemorySink(d);
    await sink.write("project", "First", "rule one", "Rules");
    await sink.write("project", "Second", "rule two", "Rules");
    const file = join(d, "CODEPILOT.md");
    const out = readFileSync(file, "utf-8");
    const rulesSection = out.split("## Rules")[1]?.split("## Architecture decisions")[0] ?? "";
    expect(rulesSection).toContain("rule one");
    expect(rulesSection).toContain("rule two");
  });
});
