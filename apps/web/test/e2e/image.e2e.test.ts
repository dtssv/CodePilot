/**
 * Real-browser E2E for image prompts: paste an image into the composer, send,
 * and check that (1) the model request carries it as an image part and (2) the
 * transcript shows the thumbnail. The model is a local fake OpenAI endpoint.
 *
 * HOME points at a temp dir before the server modules load, so the session
 * can't pick up the developer's real providers or sticky model.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WebSocketServerHandle } from "@codepilot/protocol/ws";
import { launchChromePage, type ChromePage } from "./cdp.js";

const CHROME = process.env.CP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const distRoot = resolve(import.meta.dirname, "../../dist");
const runnable = existsSync(CHROME) && existsSync(join(distRoot, "index.html"));

interface ChatRequest {
  messages: { role: string; content: string | { type: string; image_url?: { url: string } }[] }[];
}

function startFakeModel(requests: ChatRequest[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body) as ChatRequest);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk({ role: "assistant", content: "Got the mockup." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}

describe.skipIf(!runnable)("web UI image prompts (real browser)", () => {
  const requests: ChatRequest[] = [];
  let home: string;
  let root: string;
  let model: Server;
  let server: WebSocketServerHandle;
  let page: ChromePage;
  const prevHome = process.env.HOME;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cp-e2e-home-"));
    root = mkdtempSync(join(tmpdir(), "cp-e2e-img-"));
    process.env.HOME = home;
    const fake = await startFakeModel(requests);
    model = fake.server;
    mkdirSync(join(root, ".codepilot"));
    writeFileSync(
      join(root, ".codepilot", "config.json"),
      JSON.stringify({
        sandbox: { mode: "off" },
        model: "fake-vision",
        providers: { fake: { provider: "openai", baseURL: fake.url, apiKey: "x", model: "fake-vision", models: ["fake-vision"] } },
      }),
    );
    const { startWebSocketServer } = await import("@codepilot/protocol/ws");
    server = await startWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      defaultCwd: root,
      staticRoot: distRoot,
      allowedOrigins: ["*"],
      token: "e2e-img-token",
    } as never);
    const httpUrl = server.url.replace(/^ws:/, "http:").replace(/\/rpc.*$/, "/");
 // Chrome itself needs the real HOME; config/session lookups keep the temp one.
    process.env.HOME = prevHome;
    page = await launchChromePage(`${httpUrl}?lang=en`);
    process.env.HOME = home;
    await page.waitFor("!!document.querySelector('input')", 15000);
  }, 40000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await server?.close().catch(() => {});
    model?.close();
    process.env.HOME = prevHome;
    for (const d of [home, root]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("sends a pasted image to the model and shows it in the transcript", async () => {
    await page.eval(`(() => {
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = Array.from(document.querySelectorAll('input'));
      set(inputs.find(i => (i.placeholder || '').includes('ws://')) ?? inputs[0], ${JSON.stringify(server.url)});
      set(inputs.find(i => (i.placeholder || '').includes('cwd')) ?? inputs[inputs.length - 1], ${JSON.stringify(root)});
      Array.from(document.querySelectorAll('button')).find(b => /connect/i.test(b.textContent || '')).click();
    })()`);
    await page.waitFor(`document.body.innerText.includes('connected') && !document.body.innerText.includes('disconnected')`, 15000);
 // Stand in for the native folder dialog.
    await page.eval(`(() => {
      window.codepilotDesktop = { pickFolder: async () => ${JSON.stringify(root)}, openPath() {} };
      Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Open workspace'))?.click();
    })()`);
    await page.waitFor(`!!document.querySelector('textarea[aria-label="Prompt"]:not([disabled])')`, 15000);

 // Paste a 40×30 red PNG drawn in the page.
    await page.eval(`(async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 30;
      const g = c.getContext('2d'); g.fillStyle = '#e11'; g.fillRect(0, 0, 40, 30);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'mockup.png', { type: 'image/png' }));
      const ta = document.querySelector('textarea[aria-label="Prompt"]');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Replicate this page as HTML');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.waitFor(`!!document.querySelector('img[alt="mockup.png"]')`, 8000);
    await page.eval(`document.querySelector('button[aria-label="Send"]').click()`);

    await page.waitFor(`document.body.innerText.includes('Got the mockup.')`, 20000).catch(async (err) => {
      const text = await page.eval<string>("document.body.innerText.slice(0, 3000)");
      throw new Error(`${String(err)}\nrequests=${requests.length}\n${text}`);
    });
    const chat = requests.find((r) => r.messages.some((m) => Array.isArray(m.content)));
    const user = chat?.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    const parts = (user?.content ?? []) as { type: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "text")).toBe(true);
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(/^data:image\/png;base64,/);

 // The user bubble renders the attachment; the composer has been cleared.
    await page.waitFor(`document.querySelectorAll('img[src^="data:image/png"]').length >= 1 && !document.querySelector('img[alt="mockup.png"]')`, 8000);
    if (process.env.CP_E2E_SHOT) writeFileSync(process.env.CP_E2E_SHOT, await page.screenshot());
  }, 60000);
});
