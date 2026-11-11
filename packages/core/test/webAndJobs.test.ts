// Tests for web tool helpers (HTML→text, DDG parser) and bash background jobs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { htmlToText, webFetchTool } from "../src/tools/web_fetch.js";
import { parseBingHtml, parseDuckDuckGoHtml } from "../src/tools/web_search.js";
import { bashTool, elideBinaryLines } from "../src/tools/bash.js";
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

describe("web_fetch domain policy + max_chars", () => {
  let dir: string;
  const artifacts = new Map<string, string>();
  const ctx = (webFetch?: unknown): ToolContext =>
    ({
      cwd: dir,
      artifact: async (blob: string | Uint8Array) => {
        const ref = `art_${artifacts.size}`;
        artifacts.set(ref, String(blob));
        return ref;
      },
      readArtifact: async (ref: string) => artifacts.get(ref) ?? "",
      sandbox: resolveSandbox({ mode: "off" }, dir),
      ...(webFetch ? { config: { webFetch } as never } : {}),
    }) as unknown as ToolContext;

  // A fetch stub that returns a body of the given length as text/plain.
  const stubFetch = (body: string, status = 200): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        url: "https://example.com/doc",
        status,
        headers: { get: (k: string) => (k === "content-type" ? "text/plain" : null) },
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: new TextEncoder().encode(body) };
              },
              async cancel() {},
            };
          },
        },
      })) as unknown as typeof fetch,
    );
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-"));
    artifacts.clear();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a blocked domain (suffix match) before fetching", async () => {
    const r = await webFetchTool.execute(
      { url: "https://api.evil.com/x" },
      ctx({ blockedDomains: ["evil.com"] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked by config/);
  });

  it("refuses a domain not on a non-empty allowlist", async () => {
    const r = await webFetchTool.execute(
      { url: "https://other.com/x" },
      ctx({ allowedDomains: ["example.com"] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not on the configured allowedDomains/);
  });

  it("allows a domain (and sub-domain) on the allowlist", async () => {
    stubFetch("hello");
    const r = await webFetchTool.execute(
      { url: "https://api.example.com/x", no_cache: true },
      ctx({ allowedDomains: ["example.com"] }),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
  });

  it("blocked overrides allowed", async () => {
    const r = await webFetchTool.execute(
      { url: "https://example.com/x" },
      ctx({ allowedDomains: ["example.com"], blockedDomains: ["example.com"] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked by config/);
  });

  it("allows any non-blocked domain when no allowlist is set (default)", async () => {
    stubFetch("ok");
    const r = await webFetchTool.execute(
      { url: "https://anything.example.org/x", no_cache: true },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("ok");
  });

  it("honours max_chars for the inline slice", async () => {
    stubFetch("x".repeat(5000));
    const r = await webFetchTool.execute(
      { url: "https://example.com/doc", no_cache: true, max_chars: 1000 },
      ctx(),
    );
    // Strip the "[HTTP 200]\n\n" header to measure just the body slice.
    const body = r.content.split("\n\n").slice(1).join("\n\n");
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  it("spills a large page to an artifact regardless of max_chars", async () => {
    stubFetch("y".repeat(200_000));
    const r = await webFetchTool.execute(
      { url: "https://example.com/doc", no_cache: true, max_chars: 500 },
      ctx(),
    );
    expect(r.artifactRef).toBeTruthy();
    expect(r.content).toMatch(/full content saved to artifact/);
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

describe("parseBingHtml", () => {
  it("extracts b_algo cards", () => {
    const html = `
      <li class="b_algo"><h2><a href="https://a.example/x">Alpha</a></h2><p>first snip</p></li>
      <li class="b_algo"><h2><a href="/relative">Skip</a></h2><p>no</p></li>
      <li class="b_algo"><h2><a href="https://b.example/y">Beta</a></h2><p>second</p></li>`;
    const hits = parseBingHtml(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ title: "Alpha", url: "https://a.example/x", snippet: "first snip" });
    expect(hits[1]!.title).toBe("Beta");
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

  it("killAllJobs stops every running job (engine-exit path)", async () => {
    const { killAllJobs, getJob } = await import("../src/tools/bashJobs.js");
    const start = await bashTool.execute(
      { command: "sleep 60", run_in_background: true },
      sandboxOffCtx(),
    );
    const id = start.content.match(/job_[a-f0-9]{8}/)![0];
    const n = await killAllJobs();
    expect(n).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 400));
    const job = await getJob(dir, id);
    expect(job?.meta.status).toMatch(/killed|exited/);
  });

  it("reports unknown jobs", async () => {
    const out = await bashOutputTool.execute({ job_id: "job_00000000" }, sandboxOffCtx());
    expect(out.isError).toBe(true);
  });

  it("times out a foreground command that spawns a pipe-holding grandchild, without hanging", async () => {
 // A shell that backgrounds a long sleep which INHERITS stdout, then the
 // shell itself waits. Before the process-group kill fix, SIGTERM hit only
 // the shell; the orphaned sleep kept the stdout pipe open so `close` never
 // fired and the tool hung forever. With the fix the whole group is killed
 // and the tool returns promptly as a timeout.
    const started = Date.now();
    const res = await bashTool.execute(
      { command: "sleep 30 & sleep 30", timeout: 800 },
      sandboxOffCtx(),
    );
    const elapsed = Date.now() - started;
 // Must return well before the 30s sleeps — i.e. shortly after the 800ms
 // timeout plus the SIGKILL grace window, not hang.
    expect(elapsed).toBeLessThan(6000);
    expect(res.content).toMatch(/\[exit (timeout|\?|null|137|143)\]/i);
    // A timeout means the command did not run to completion → an error.
    expect(res.isError).toBe(true);
  }, 15000);

  it("marks a plain foreground timeout as an error", async () => {
    // No grandchildren, just a sleep that outlasts the timeout — the one-shot
    // runCommand path. Before the fix this returned isError:false because the
    // kill used SIGTERM and timedOut was hardcoded false.
    const res = await bashTool.execute(
      { command: "sleep 30", timeout: 500 },
      sandboxOffCtx(),
    );
    expect(res.isError).toBe(true);
  }, 15000);

  it("a successful foreground command is not an error", async () => {
    const res = await bashTool.execute(
      { command: "echo hi", timeout: 5000 },
      sandboxOffCtx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("hi");
  });

  it("a non-zero exit (no timeout) is data, not an error", async () => {
    const res = await bashTool.execute(
      { command: "exit 3", timeout: 5000 },
      sandboxOffCtx(),
    );
    // Non-zero exit is surfaced but not flagged as a tool error.
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/\[exit 3\]/);
  });
});

describe("bash exit-code vs isError", () => {
  let dir: string;
  const sandboxOffCtx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir ?? "/tmp"),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpexit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A non-zero exit is DATA, not a failure. grep/find/diff/test exit non-zero on
  // a normal "no match"; a pipeline's exit is just its last command's. isError
  // is reserved for commands that did not run to completion (timeout / hard kill).
  it("does not mark a plain non-zero exit as error, but surfaces [exit N]", async () => {
    const res = await bashTool.execute({ command: "exit 1" }, sandboxOffCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/\[exit 1\]/);
  });

  it("grep no-match in a pipeline is not an error (the classic false failure)", async () => {
    // First grep matches, second finds nothing → pipeline exits 1. Must NOT be
    // treated as a failed command.
    const res = await bashTool.execute(
      { command: "printf 'alpha\\nbeta\\n' | grep alpha | grep zzz_no_match" },
      sandboxOffCtx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/\[exit 1\]/);
  });

  it("a successful command stays non-error with no exit marker", async () => {
    const res = await bashTool.execute({ command: "echo ok" }, sandboxOffCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("ok");
    expect(res.content).not.toMatch(/\[exit/);
  });
});

describe("elideBinaryLines", () => {
  it("collapses binary runs and keeps the surrounding text", () => {
    const bin = "\u001f\ufffd\b\u0000\ufffdx\ufffd\u0003";
    const out = elideBinaryLines(`log line 1\n${bin}\n${bin}\nlog line 2`);
    expect(out).toBe(`log line 1\n[binary data omitted: ${(bin.length + 1) * 2} bytes]\nlog line 2`);
  });

  it("returns plain text untouched", () => {
    const text = "a\tb\r\nc\n";
    expect(elideBinaryLines(text)).toBe(text);
  });
});
