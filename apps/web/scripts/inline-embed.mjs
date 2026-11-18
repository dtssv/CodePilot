// Collapse dist-embed/ into one self-contained index.html.
//
// - <link rel="stylesheet"> becomes <style> in <head>; <script src> becomes
// an inline module script at the end of <body>, with "</script" escaped so
// the bundle cannot close the tag early.
// - The page's own CSP meta is removed: each host injects a stricter one
// (VSCode adds a nonce to the script tag; see apps/vscode/src/webview-html.ts).
// Replacer functions are used throughout so "$&"-like sequences in the
// bundle are kept literally.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(import.meta.dirname, "..", "dist-embed");
const indexPath = join(dir, "index.html");
const read = (href) => readFileSync(join(dir, href.replace(/^\.?\//, "")), "utf8");

let html = readFileSync(indexPath, "utf8");
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, () => "");
html = html.replace(/<!--[\s\S]*?-->\s*/g, () => "");

const styles = [];
html = html.replace(/<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>\s*/g, (_m, href) => {
  styles.push(`<style>${read(href)}</style>`);
  return "";
});

const scripts = [];
html = html.replace(/<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>\s*/g, (_m, src) => {
  const js = read(src).replace(/<\/script/gi, () => "<\\/script");
  scripts.push(`<script type="module">${js}</script>`);
  return "";
});

// Idempotent: a prior run (or a host that already inlined) leaves <style> /
// <script type="module"> without href/src. Treat that as done.
const alreadyInlined =
  styles.length === 0 &&
  scripts.length === 0 &&
  /<style[\s>]/.test(html) &&
  /<script\s+type="module">/.test(html);
if (alreadyInlined) {
  rmSync(join(dir, "assets"), { recursive: true, force: true });
  console.log(`inline-embed: ${indexPath} already inlined (${(html.length / 1024).toFixed(0)} KiB)`);
  process.exit(0);
}
if (styles.length === 0 || scripts.length === 0) {
  throw new Error("inline-embed: expected one stylesheet and one module script in dist-embed/index.html");
}

html = html.replace("</head>", () => `${styles.join("\n")}\n</head>`);
html = html.replace("</body>", () => `${scripts.join("\n")}\n</body>`);

writeFileSync(indexPath, html);
rmSync(join(dir, "assets"), { recursive: true, force: true });
console.log(`inline-embed: ${indexPath} (${(html.length / 1024).toFixed(0)} KiB)`);
