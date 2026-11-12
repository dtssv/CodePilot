/**
 * `codepilot agent`: serves the web UI + protocol on one loopback port, then
 * opens the agent layout in a chromeless Chromium `--app` window (stops on
 * close); falls back to the default browser if none is available.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppBrowser {
  name: string;
  path: string;
}

type Exists = (path: string) => boolean;

/** Chromium-family browsers that support `--app`, most common first. */
export function findAppBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = existsSync,
): AppBrowser | null {
  const candidates: AppBrowser[] = [];
  if (platform === "darwin") {
    const apps = [
      ["Google Chrome", "Google Chrome"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Chromium", "Chromium"],
      ["Brave Browser", "Brave Browser"],
    ];
    for (const root of ["/Applications", join(env.HOME ?? homedir(), "Applications")]) {
      for (const [app, bin] of apps) {
        candidates.push({ name: app!, path: `${root}/${app}.app/Contents/MacOS/${bin}` });
      }
    }
  } else if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push({ name: "Google Chrome", path: join(root, "Google", "Chrome", "Application", "chrome.exe") });
      candidates.push({ name: "Microsoft Edge", path: join(root, "Microsoft", "Edge", "Application", "msedge.exe") });
    }
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const name of names) candidates.push({ name, path: join(dir, name) });
    }
  }
  return candidates.find((c) => exists(c.path)) ?? null;
}

/** Browsers cannot open http://0.0.0.0/ — map wildcard bind to loopback for local UI. */
function browserHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/** The page URL that opens the agent layout and connects with `token`. */
export function agentPageUrl(host: string, port: number, token: string | undefined, cwd: string): string {
  const q = new URLSearchParams({ layout: "agent", cwd });
  if (token) q.set("token", token);
  return `http://${browserHost(host)}:${port}/?${q.toString()}`;
}

/** Web layout URL with token so the SPA auto-connects (token stripped from history). */
export function webPageUrl(
  host: string,
  port: number,
  token: string | undefined,
): string {
  const q = new URLSearchParams({ layout: "web" });
  if (token) q.set("token", token);
  return `http://${browserHost(host)}:${port}/?${q.toString()}`;
}

/**
 * Locate the built web SPA directory (containing `index.html`): packaged-binary
 * layout first, then source/npm layout. Returns undefined if neither exists;
 * pass `what` to emit a build hint to stderr on miss.
 */
export function detectWebRoot(what?: string): string | undefined {
  const candidates: string[] = [];
  try {
    candidates.push(resolve(dirname(process.execPath), "web"));
  } catch {
    /* ignore */
  }
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    candidates.push(resolve(here, "..", "..", "..", "apps", "web", "dist"));
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  if (what) {
    process.stderr.write(
      `${what}: no web UI found (looked in: ${candidates.join(", ")})\n` +
        `Build it first (pnpm --filter @codepilot/web build) or pass --web-root <dir>.\n`,
    );
  }
  return undefined;
}

/** Open a URL in the default browser (tab), fire-and-forget. */
export function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
}

export function appWindowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1320,880",
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export interface OpenedWindow {
 /** Resolves when the window (its browser process) exits; never for a shared browser. */
  closed: Promise<void>;
  kind: "app" | "browser";
  browser?: string;
}

export function openAgentWindow(url: string, profileDir = join(homedir(), ".codepilot", "agent-window")): OpenedWindow {
  const browser = findAppBrowser();
  if (browser) {
    mkdirSync(profileDir, { recursive: true });
    const proc = spawn(browser.path, appWindowArgs(url, profileDir), { stdio: "ignore" });
    return { closed: exited(proc), kind: "app", browser: browser.name };
  }
  const opener =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true }).unref();
  return { closed: new Promise(() => {}), kind: "browser" };
}

function exited(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
    proc.once("error", () => resolve());
  });
}
