/**
 * Embedded web UI for the self-contained binary: with Bun `--compile` the
 * SPA is embedded via a generated VFS module; `materializeEmbeddedWeb`
 * copies it to a temp dir for the static server, else `detectWebRoot`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { webVfs } from "./web-vfs.generated.js";

/** Map of SPA-relative path (e.g. "index.html", "assets/app.js") to the
 * embedded file's runtime path (an absolute `/$bunfs/...` path in a compiled
 * binary). Empty in the source/npm build. */
export type WebVfs = Record<string, string>;

/** Whether a web UI is embedded in this binary. */
export function hasEmbeddedWeb(): boolean {
  return Object.keys(webVfs).length > 0;
}

/**
 * Copy the embedded web SPA to a fresh temp directory and return its path, or
 * undefined when nothing is embedded. The directory contains `index.html` at
 * its root, so it can be passed straight to the static server as `--web-root`.
 */
export function materializeEmbeddedWeb(): string | undefined {
  const entries = Object.entries(webVfs);
  if (entries.length === 0) return undefined;
  const root = mkdtempSync(join(tmpdir(), "codepilot-web-"));
  for (const [rel, src] of entries) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      // Read the embedded bytes and write a real file. `readFileSync` works on
      // the Bun virtual FS (`/$bunfs/...`) where `cpSync`/`lstat` do not.
      writeFileSync(dest, readFileSync(src));
    } catch {
      // A missing embedded file is non-fatal: the SPA may still work without
      // an optional asset, and index.html is checked by the caller.
    }
  }
  return existsSync(join(root, "index.html")) ? root : undefined;
}

/** Internal: used only by the generator's self-check in tests. */
export function __writeProbe(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}
