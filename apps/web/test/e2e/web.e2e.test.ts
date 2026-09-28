/**
 * Real-browser E2E: built SPA + real protocol server + headless Chrome (CDP).
 *
 * Covers the connect → session → workspace pipeline end-to-end:
 *  1. SPA loads from the same server that hosts the WebSocket (no dev server).
 *  2. Connect with the printed ws:// URL (token included).
 *  3. New session appears; workspace panel lists the temp project files.
 *  4. Open a file, edit it, save — content round-trips through workspace/write.
 *  5. External modification is detected (stat hash change → save blocked).
 *  6. Live file watch pushes a refresh when a file changes on disk.
 *
 * Skipped automatically when no Chrome binary is available (CI without a
 * browser), so `vitest run` stays green everywhere.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startWebSocketServer, type WebSocketServerHandle } from "@codepilot/protocol/ws";
import { launchChromePage, type ChromePage } from "./cdp.js";

const CHROME = process.env.CP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = existsSync(CHROME);
const distIndex = resolve(import.meta.dirname, "../../dist/index.html");
const hasBuild = existsSync(distIndex);

async function startServerFor(root: string, port = 0, token?: string): Promise<WebSocketServerHandle> {
  return startWebSocketServer({
    port,
    host: "127.0.0.1",
    defaultCwd: root,
    staticRoot: resolve(import.meta.dirname, "../../dist"),
    // The page is same-origin; allow everything for the loopback test.
    allowedOrigins: ["*"],
    ...(token ? { token } : {}),
  } as never);
}

function portOf(server: WebSocketServerHandle): number {
  return Number(new URL(server.url).port);
}

async function connectThroughUI(page: ChromePage, server: WebSocketServerHandle, cwd: string): Promise<void> {
  const result = await page.eval<string>(`(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input'));
    const serverInput = inputs.find(i => (i.placeholder || '').includes('ws://')) ?? inputs[0];
    const cwdInput = inputs.find(i => (i.placeholder || '').includes('cwd') || (i.getAttribute('aria-label') || '').includes('cwd')) ?? inputs[inputs.length - 1];
    set(serverInput, ${JSON.stringify(server.url)});
    set(cwdInput, ${JSON.stringify(cwd)});
    const connectBtn = Array.from(document.querySelectorAll('button')).find(b => /connect/i.test(b.textContent || ''));
    if (!connectBtn) return 'no-connect-button';
    connectBtn.click();
    return 'clicked';
  })()`);
  expect(result).toBe("clicked");
  await page.waitFor(`document.body.innerText.includes('connected')`, 15000);
}

describe.skipIf(!hasChrome || !hasBuild)("web UI real-browser E2E", () => {
  let server: WebSocketServerHandle;
  let page: ChromePage;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cp-e2e-project-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), "# e2e project\nhello e2e\n", "utf8");
    writeFileSync(join(root, "src", "main.ts"), "export const version = 1;\n", "utf8");

    server = await startServerFor(root, 0, "e2e-reconnect-token");
    const httpUrl = server.url.replace(/^ws:/, "http:").replace(/\/rpc.*$/, "/");
    page = await launchChromePage(httpUrl);
    await page.waitFor("document.readyState === 'complete' || document.readyState === 'interactive'");
    await page.waitFor("!!document.querySelector('input')");
  }, 40000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("connects, creates a session, browses the workspace, edits and saves a file", async () => {
    // --- connect through the real UI -------------------------------------
    await connectThroughUI(page, server, root);
    await page.waitFor(`document.body.innerText.includes('Workspace')`, 15000);

    // --- new session -------------------------------------------------------
    await page.eval<void>(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /^new$/i.test((b.textContent || '').trim()));
      btn?.click();
    })()`);
    await page.waitFor(`!document.body.innerText.includes('Start a') || document.body.innerText.includes('agent')`, 15000);

    // --- workspace: file tree shows the temp project -----------------------
    await page.waitFor(`document.body.innerText.includes('README.md')`, 15000);
    await page.waitFor(`document.body.innerText.includes('src')`, 15000);

    // Open README.md by clicking its file-tree entry (tree entries are the
    // buttons whose text starts with the "· " marker).
    const buttons = await page.eval<string[]>(`Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(Boolean)`);
    expect(buttons.some(b => b.includes("README.md"))).toBe(true);
    const clickedFile = await page.eval<string>(`(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.textContent || '').includes('README.md'));
      if (!btn) return 'not-found';
      btn.click();
      return 'clicked';
    })()`);
    expect(clickedFile).toBe("clicked");
    try {
      await page.waitFor(`document.querySelector('textarea[aria-label="File editor"]')`, 15000);
    } catch (err) {
      const probe = await page.eval<string>(`(() => {
        const tas = Array.from(document.querySelectorAll('textarea')).map(t => ({ aria: t.getAttribute('aria-label'), len: t.value.length, readOnly: t.readOnly }));
        const asides = Array.from(document.querySelectorAll('aside')).length;
        const pres = Array.from(document.querySelectorAll('aside pre')).map(p => p.textContent?.slice(0, 40));
        return JSON.stringify({ tas, asides, pres });
      })()`);
      throw new Error(`editor did not open; probe: ${probe}; page errors: ${page.pageErrors().join(" | ")} (${String(err)})`);
    }
    const initialContent = await page.eval<string>(`document.querySelector('textarea[aria-label="File editor"]').value`);
    expect(initialContent).toContain("hello e2e");

    // Edit + save through the real editor.
    await page.eval<void>(`(() => {
      const ta = document.querySelector('textarea[aria-label="File editor"]');
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set.call(ta, '# e2e project\\nhello edited\\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.waitFor(`document.body.innerText.includes('modified')`, 8000);
    await page.eval<void>(`window.confirm = () => true`);
    await page.eval<void>(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Save');
      btn?.click();
    })()`);
    await page.waitFor(`!document.body.innerText.includes('modified')`, 8000);
    const onDisk = readFileSync(join(root, "README.md"), "utf8");
    expect(onDisk).toContain("hello edited");

    // --- external modification detection -----------------------------------
    writeFileSync(join(root, "README.md"), "# external change\n", "utf8");
    await page.waitFor(`document.body.innerText.includes('changed externally')`, 15000);
    const saveDisabled = await page.eval<boolean>(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Save');
      return !btn || btn.disabled;
    })()`);
    expect(saveDisabled).toBe(true);

    // --- live file watch refreshes the listing ------------------------------
    writeFileSync(join(root, "WATCHED.txt"), "watcher test\n", "utf8");
    try {
      await page.waitFor(`document.body.innerText.includes('WATCHED.txt')`, 15000);
    } catch (err) {
      const probe = await page.eval<string>(`(() => {
        const panel = Array.from(document.querySelectorAll('aside')).pop();
        return panel ? panel.innerText.slice(0, 1500) : '(no aside)';
      })()`);
      throw new Error(`watch did not refresh listing; panel:\\n${probe}\\n(${String(err)})`);
    }
  }, 90000);

  it("auto-reconnects after a server restart and restores the session", async () => {
    const token = "e2e-reconnect-token";
    const port = portOf(server);
    await page.eval<void>(`(() => Array.from(document.querySelectorAll('button')).find(b => /^disconnect$/i.test((b.textContent || '').trim()))?.click())()`);
    await page.waitFor(`document.body.innerText.includes('disconnected')`, 8000);
    await server.close();
    server = await startServerFor(root, port, token);
    await connectThroughUI(page, server, root);
    const newClicked = await page.eval<boolean>(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^new$/i.test((b.textContent || '').trim())); if (!b) return false; b.click(); return true; })()`);
    expect(newClicked).toBe(true);
    await page.waitFor(`document.body.innerText.includes('Workspace')`, 15000);

    await server.close();
    await page.waitFor(`document.body.innerText.includes('reconnecting') || document.body.innerText.includes('disconnected')`, 15000);
    server = await startServerFor(root, port, token);
    await page.waitFor(`document.body.innerText.includes('connected') && !document.body.innerText.includes('disconnected')`, 30000);
    await page.waitFor(`document.body.innerText.includes('reconnected') || document.body.innerText.includes('Workspace')`, 30000);
    await page.waitFor(`document.body.innerText.includes('README.md')`, 15000);
  }, 90000);
});
