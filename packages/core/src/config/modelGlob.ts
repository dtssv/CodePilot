/** Anchored glob matcher for model ids (`*` / `?`, case-insensitive).
 * Provider prefixes (`openrouter/anthropic/…`) are tolerated via a basename
 * fallback after the last `/`. Pure — safe for browser bundles. */

export function modelGlobMatch(pattern: string, modelId: string): boolean {
  const re =
    "^" +
    pattern
      .split(/(\*|\?)/)
      .map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("") +
    "$";
  let rx: RegExp;
  try {
    rx = new RegExp(re, "i");
  } catch {
    return false;
  }
  if (rx.test(modelId)) return true;
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 && rx.test(modelId.slice(slash + 1));
}
