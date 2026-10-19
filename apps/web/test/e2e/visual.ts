/**
 * Visual smoke run (manual, not part of `vitest`): drives a real session
 * against a scripted OpenAI-compatible mock and screenshots each layout.
 *
 * pnpm --filter @codepilot/web build
 * npx tsx apps/web/test/e2e/visual.ts [outDir]
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { launchChromePage, type ChromePage } from "./cdp.js";

// Sessions persist under $HOME/.codepilot; keep the demo runs out of the
// real one. Set before the protocol package (and core) is loaded.
process.env.HOME = mkdtempSync(join(tmpdir(), "cp-visual-home-"));
const { startWebSocketServer } = await import("@codepilot/protocol/ws");

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "cp-visual"));
mkdirSync(outDir, { recursive: true });

type Call = { name: string; args: unknown };
type Turn = { text?: string; calls?: Call[] };

const PLAN = (a: string, b: string, c: string) => ({
  steps: [
    { id: "1", title: "Survey the project layout", status: a },
    { id: "2", title: "Read the README and entry point", status: b },
    { id: "3", title: "Write REPORT.md with findings", status: c },
  ],
});

const SCRIPT: Turn[] = [
  {
    text: "I'll start by surveying the project and laying out a plan.",
    calls: [
      { name: "plan_update", args: PLAN("in_progress", "pending", "pending") },
      { name: "ls", args: { path: "." } },
    ],
  },
  {
    calls: [
      { name: "read_file", args: { path: "README.md" } },
      { name: "grep", args: { pattern: "export", path: "src" } },
      { name: "plan_update", args: PLAN("completed", "completed", "in_progress") },
    ],
  },
  {
    text: "I have what I need — writing the report now.",
    calls: [
      {
        name: "write_file",
        args: {
          path: "REPORT.md",
          content: "# Project report\n\n- Entry point: `src/main.ts`\n- Exports a single `version` constant\n\n## Next steps\n\n1. Add tests\n2. Document the API\n",
        },
      },
    ],
  },
  {
    calls: [{ name: "plan_update", args: PLAN("completed", "completed", "completed") }],
  },
  {
    text:
      "Done. Here is a summary of the project:\n\n" +
      "## Overview\n\nA tiny TypeScript package with one module.\n\n" +
      "| File | Purpose |\n|---|---|\n| `README.md` | Project intro |\n| `src/main.ts` | Exports `version` |\n\n" +
      "```ts\nexport const version = 1;\n```\n\n" +
      "I wrote the findings to **REPORT.md**.",
  },
];

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function body(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

const mock = createServer(async (req, res) => {
  const payload = JSON.parse(await body(req)) as { messages: Array<{ role: string; content?: unknown }> };
  const turnIdx = payload.messages.filter((m) => m.role === "assistant").length;
  if (process.env.CP_VISUAL_DEBUG) {
    const lastTool = [...payload.messages].reverse().find((m) => m.role === "tool");
    console.log(`turn ${turnIdx}: last tool result →`, String(lastTool?.content ?? "").slice(0, 300));
  }
  const turn = SCRIPT[Math.min(turnIdx, SCRIPT.length - 1)]!;
  const chunks: unknown[] = [];
  if (turn.text) {
    for (const word of turn.text.match(/.{1,12}/gs) ?? []) {
      chunks.push({ choices: [{ index: 0, delta: { content: word } }] });
    }
  }
  (turn.calls ?? []).forEach((c, i) => {
    chunks.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: i, id: `call_${turnIdx}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }],
        },
      }],
    });
  });
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: turn.calls ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 1800 + turnIdx * 400, completion_tokens: 120 } });
 // Slow down so screenshots can catch a run in progress.
  await new Promise((r) => setTimeout(r, 350));
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse(chunks));
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = (mock.address() as { port: number }).port;

process.env.CODEPILOT_PROVIDER = "openai";
process.env.CODEPILOT_BASE_URL = `http://127.0.0.1:${mockPort}`;
process.env.CODEPILOT_API_KEY = "mock";
process.env.CODEPILOT_MODEL = "gpt-mock";

const root = mkdtempSync(join(tmpdir(), "cp-visual-project-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "README.md"), "# demo\nA tiny demo project.\n");
writeFileSync(join(root, "src", "main.ts"), "export const version = 1;\n");

const token = "visual-token";
const server = await startWebSocketServer({
  port: 0,
  host: "127.0.0.1",
  defaultCwd: root,
  staticRoot: resolve(import.meta.dirname, "../../dist"),
  allowedOrigins: ["*"],
  token,
} as never);
const http = server.url.replace(/^ws:/, "http:").replace(/\/rpc.*$/, "/");

async function shot(page: ChromePage, name: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(join(outDir, `${name}.png`), await page.screenshot());
  console.log(join(outDir, `${name}.png`));
}

async function run(layout: string, theme: string, lang: string, prompt: string, size?: string): Promise<void> {
  const page = await launchChromePage(
    `${http}?layout=${layout}&theme=${theme}&lang=${lang}&token=${token}&cwd=${encodeURIComponent(root)}`,
  );
  try {
    if (size) {
      const [w, h] = size.split("x").map(Number);
      await page.setViewport(w!, h!);
    }
    await page.waitFor(`location.protocol === "http:" && document.readyState === "complete"`);
    await page.eval(`localStorage.setItem('codepilot.theme', '${theme}')`);
    await page.waitFor(`document.body.innerText.includes('${lang === "zh" ? "已连接" : "connected"}')`, 15000);
    if (layout === "agent") await shot(page, `${layout}-${theme}-home`);
    await page.eval(`(() => {
      const ta = document.querySelector('textarea[aria-label="Prompt"]');
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set.call(ta, ${JSON.stringify(prompt)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 100));
    await page.eval(`document.querySelector('textarea[aria-label="Prompt"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
 // write_file asks for permission in the default "ask" mode.
    await page.waitFor(`document.body.innerText.includes('REPORT.md') && !!Array.from(document.querySelectorAll('button')).find(b => /Allow once|允许一次/.test(b.textContent || ''))`, 20000);
    await shot(page, `${layout}-${theme}-permission`);
    await page.eval(`Array.from(document.querySelectorAll('button')).find(b => /Allow once|允许一次/.test(b.textContent || '')).click()`);
    await page.waitFor(`document.body.innerText.includes('Project report') || document.body.innerText.includes('Overview')`, 20000);
    await shot(page, `${layout}-${theme}-done`);
    const errs = page.pageErrors();
    if (errs.length) console.log("page errors:", errs);
  } finally {
    await page.close();
  }
}

/**
 * The IDE path: the single-file embed build, with the page talking to a real
 * `codepilot serve` over stdio through the host bridge. The harness plays
 * the JCEF host (inject `__codepilotHostPost` after load, deliver with
 * `__codepilotReceive`), which is the same contract VSCode uses.
 */
async function runBridge(prompt: string): Promise<void> {
  const engine = spawn(process.execPath, [resolve(import.meta.dirname, "../../../../packages/protocol/dist/cli.js"), "serve"], {
    cwd: root,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const page = await launchChromePage(
    `${pathToFileURL(resolve(import.meta.dirname, "../../dist-embed/index.html"))}?host=idea&lang=zh&theme=dark`,
  );
  const toPage: unknown[] = [];
  let buf = "";
  engine.stdout.setEncoding("utf8");
  engine.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) toPage.push({ type: "rpc", line });
    }
  });
  let pumping = true;
  const pump = (async () => {
    while (pumping) {
      const out = await page.eval<string[]>(`(window.__cpOutbox || []).splice(0)`).catch(() => [] as string[]);
      for (const raw of out ?? []) {
        const msg = JSON.parse(raw) as { type: string; line?: string };
        if (msg.type === "rpc") engine.stdin.write(`${msg.line}\n`);
        else if (msg.type === "ready") {
          toPage.push({ type: "host/init", cwd: root, theme: "dark", locale: "zh", surface: "idea" });
          toPage.push({ type: "host/engine", state: "ready" });
        }
      }
      const batch = toPage.splice(0);
      if (batch.length) {
        await page.eval(`(${JSON.stringify(batch.map((m) => JSON.stringify(m)))}).forEach((m) => window.__codepilotReceive(m))`).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  })();
  try {
    await page.setViewport(420, 900);
    await page.waitFor(`typeof window.__codepilotReceive === "function"`);
    await page.eval(`window.__cpOutbox = []; window.__codepilotHostPost = (m) => window.__cpOutbox.push(m)`);
    await page.waitFor(`!!document.querySelector('textarea[aria-label="Prompt"]') && !document.querySelector('textarea[aria-label="Prompt"]').disabled`, 15000);
    await page.eval(`window.__codepilotReceive(${JSON.stringify(JSON.stringify({ type: "host/prompt", text: prompt, send: true }))})`);
    await page.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b => /允许一次/.test(b.textContent || ''))`, 20000);
    await shot(page, "bridge-idea-permission");
    await page.eval(`Array.from(document.querySelectorAll('button')).find(b => /允许一次/.test(b.textContent || '')).click()`);
    await page.waitFor(`document.body.innerText.includes('Overview')`, 20000);
    await shot(page, "bridge-idea-done");
    const errs = page.pageErrors();
    if (errs.length) console.log("page errors:", errs);
  } finally {
    pumping = false;
    await pump;
    await page.close();
    engine.kill();
  }
}

const only = process.env.CP_VISUAL_ONLY;
try {
  if (only === "bridge") {
    await runBridge("帮我分析一下这个项目并写一份报告");
    process.exit(0);
  }
  await run("agent", "light", "zh", "帮我分析一下这个项目并写一份报告");
  await run("web", "dark", "en", "Analyze this project and write a report");
  await run("agent", "dark", "en", "Analyze this project and write a report");
  await run("embedded", "dark", "zh", "帮我分析一下这个项目并写一份报告", "420x900");
  await runBridge("帮我分析一下这个项目并写一份报告");
} finally {
  await server.close();
  mock.close();
}
