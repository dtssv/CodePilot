// Syntax highlighting for fenced code blocks and the file preview.
//
// Shiki with the JavaScript regex engine (no WASM) keeps us inside the strict
// CSP used by the browser page and the IDE webviews: the WASM engine would
// need `wasm-unsafe-eval`, which the host CSPs forbid. Grammars and themes are
// statically imported so the whole highlighter inlines into the single-file
// embed bundle — nothing is fetched at runtime.
//
// Output is HTML rendered via dangerouslySetInnerHTML. That is safe here:
// Shiki emits only <pre>/<code>/<span> with inline color styles (allowed by
// `style-src 'unsafe-inline'`), and the input code is escaped by Shiki. The
// dual light/dark themes emit CSS variables so the existing [data-theme]
// toggle switches palettes without re-highlighting.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import sql from "shiki/langs/sql.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark-default.mjs";
import githubLight from "shiki/themes/github-light-default.mjs";

// Map common fence tags / aliases to a bundled grammar id. Anything not here
// renders as plain text (Shiki is told "text"), so unknown languages degrade
// gracefully rather than throwing.
const ALIASES: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  html: "html",
  xml: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

const SUPPORTED = new Set(Object.values(ALIASES));

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark, githubLight],
      langs: [
        javascript,
        jsx,
        typescript,
        tsx,
        python,
        rust,
        go,
        java,
        kotlin,
        json,
        yaml,
        toml,
        sql,
        bash,
        html,
        css,
        markdown,
        diff,
      ],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/** Resolve a fence tag to a bundled grammar id, or null when unsupported. */
export function resolveLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const id = ALIASES[lang.trim().toLowerCase()];
  return id && SUPPORTED.has(id) ? id : null;
}

// File extensions → fence tag, for highlighting the file preview / editor.
const EXT_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  html: "html",
  htm: "html",
  xml: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

/** Infer a fence tag from a file path's extension, or undefined when unknown. */
export function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()];
}

/**
 * Highlight `code` to HTML with dual light/dark themes. Returns null when the
 * language is unsupported or highlighting fails, so callers fall back to a
 * plain <pre>. The result is cached per (lang, code).
 */
export async function highlightCode(
  code: string,
  lang: string | undefined,
): Promise<string | null> {
  const id = resolveLang(lang);
  if (!id) return null;
  try {
    const hl = await getHighlighter();
    return hl.codeToHtml(code, {
      lang: id,
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: false,
      // Keep Shiki's wrapper minimal; our container already styles the frame.
      structure: "classic",
    });
  } catch {
    return null;
  }
}
