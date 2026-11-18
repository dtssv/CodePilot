/** Path helpers for transcript links and the in-app file preview.
 * Anchor-aware (`foo.ts:42`) detection reuses the protocol parser so web and
 * server strip `:line[:col]` the same way. Import via `@codepilot/protocol/paths`
 * (not the package root) so the browser bundle never pulls in the RPC server. */

import {
  looksLikeWorkspacePath as protocolLooksLike,
  parseReference,
  type ParsedReference,
} from "@codepilot/protocol/paths";

export { parseReference, type ParsedReference };

/** Heuristic: does this string look like a workspace file path worth previewing? */
export function looksLikeWorkspacePath(raw: string): boolean {
  return protocolLooksLike(raw);
}

/** Prefer preview-in-app for these kinds. Strips a trailing `:line[:col]` first. */
export function previewKind(path: string): "markdown" | "image" | "code" | "text" {
  const lower = parseReference(path).path.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return "markdown";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) return "image";
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|ya?ml|toml|xml|html?|css|scss|less|py|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|sql|graphql|proto|swift|dart|vue|svelte|txt|log|csv|tsv|ini|cfg|conf|env|gitignore|dockerignore|editorconfig)$/.test(
      lower,
    )
  ) {
    return "code";
  }
  return "text";
}
