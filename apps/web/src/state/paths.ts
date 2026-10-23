/** Heuristic: does this string look like a workspace file path worth previewing? */
export function looksLikeWorkspacePath(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 260) return false;
  if (/\s/.test(s) || s.includes("\n") || s.includes("\0")) return false;
  if (/^(https?|mailto|data):/i.test(s)) return false;
  if (/^[a-z0-9+-]+:\/\//i.test(s)) return false;
  // Bare tool names / flags
  if (/^-+/.test(s)) return false;
  // Has an extension, or a path separator
  if (/\.[a-z0-9]{1,16}$/i.test(s)) return true;
  if (s.includes("/") || s.includes("\\")) return true;
  return false;
}

/** Prefer preview-in-app for these kinds. */
export function previewKind(path: string): "markdown" | "image" | "code" | "text" {
  const lower = path.toLowerCase();
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
