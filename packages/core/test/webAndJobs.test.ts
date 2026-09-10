// Tests for web tool helpers (HTML→text, DDG parser) and bash background jobs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { htmlToText } from "../src/tools/web_fetch.js";
import { parseDuckDuckGoHtml } from "../src/tools/web_search.js";
import { bashTool } from "../src/tools/bash.js";
import { bashOutputTool } from "../src/tools/bash_output.js";
import { bashKillTool } from "../src/tools/bash_kill.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("htmlToText", () => {
  it("strips scripts, styles and tags; keeps text", () => {
    const html = `<html><head><style>body{color:red}</style></head>
      <body><h1>Title</h1><p>Hello <b>world</b></p>
      <script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).toContain("- one");
  });

  it("decodes entities and collapses whitespace", () => {
    expect(htmlToText("<p>a &amp; b&nbsp;&nbsp;c</p>")).toBe("a & b c");
  });
});

describe("parseDuckDuckGoHtml", () => {
  it("extracts results and unwraps uddg redirects", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
      <a class="result__snippet">The official example documentation.</a>
      <a class="result__a" href="https://direct.example.com/x">Direct Link</a>
      <a class="result__snippet">Snippet two</a>`;
    const hits = parseDuckDuckGoHtml(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.url).toBe("https://example.com/docs");
    expect(hits[0]!.title).toBe("Example Docs");
    expect(hits[0]!.snippet).toContain("official example");
    expect(hits[1]!.url).toBe("https://direct.example.com/x");
  });

  it("returns [] on unexpected markup", () => {
    expect(parseDuckDuckGoHtml("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("bash background jobs", () => {
  let dir: string;
  const sandboxOffCtx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir ?? "/tmp"),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpjobs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a job to completion and reads its output", async () => {
    const start = await bashTool.execute(
      { command: "echo hello-bg; sleep 0.1; echo done", run_in_background: true },
      sandboxOffCtx()
    );
    expect(start.isError).toBeFalsy();
    const m = start.content.match(/job_[a-f0-9]{8}/);
    expect(m).toBeTruthy();
    const id = m![0];
    // wait for completion
    await new Promise((r) => setTimeout(r, 700));
    const out = await bashOutputTool.execute({ job_id: id }, sandboxOffCtx());
    expect(out.content).toContain("hello-bg");
    expect(out.content).toContain("done");
    expect(out.content).toMatch(/exited \(exit 0\)/);
  });

  it("kills a running job", async () => {
    const start = await bashTool.execute(
      { command: "sleep 60", run_in_background: true },
      sandboxOffCtx()
    );
    const id = start.content.match(/job_[a-f0-9]{8}/)![0];
    const killed = await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    expect(killed.content).toContain("SIGTERM");
    const out = await bashOutputTool.execute({ job_id: id }, sandboxOffCtx());
    expect(out.content).toMatch(/killed/);
  });

  it("reports unknown jobs", async () => {
    const out = await bashOutputTool.execute({ job_id: "job_00000000" }, sandboxOffCtx());
    expect(out.isError).toBe(true);
  });
});
