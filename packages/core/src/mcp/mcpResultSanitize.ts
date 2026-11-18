// Treat MCP server output as UNTRUSTED data. A tool result comes from an
// external process the agent does not control, so its bytes must not be able to
// carry hidden instructions to the model. This strips invisible/ambiguous code
// points that are used to smuggle text past a human reviewer while still being
// read by the model: Unicode "Tag" characters (U+E0000–U+E007F, an ASCII mirror
// that renders as nothing), zero-width and directional format controls (general
// category Cf), private-use code points (Co), and unassigned code points (Cn).
// Ordinary whitespace the agent legitimately relies on — tab, newline, carriage
// return — is explicitly kept.
//
// This is a defence-in-depth measure, not a complete prompt-injection fix: it
// removes a specific class of hidden-character smuggling (cf. the public
// HackerOne report against MCP hidden-Unicode tag characters) but does not stop
// a server from embedding visible adversarial instructions. The system prompt's
// "tool results are external data" guidance covers the visible case.

/** Whitespace that is always safe to keep even though some would otherwise fall
 * under a stripped general category. */
const KEEP = new Set(["\t", "\n", "\r"]);

/** Matches a single code point in a stripped Unicode general category:
 * - Cf: format controls (zero-width space/joiner, bidi overrides, U+E0001 …)
 * - Co: private-use (including the SPUA-A/B planes)
 * - Cn: unassigned
 * The `u` flag makes `.` / property escapes operate on whole code points. */
const STRIP_RE = /[\p{Cf}\p{Co}\p{Cn}]/u;

/**
 * Remove hidden/invisible code points from untrusted MCP text so they cannot be
 * used to smuggle instructions to the model. Returns the cleaned string. Pure
 * and allocation-light: when nothing is stripped the input is returned as-is.
 *
 * Only character REMOVAL is performed — no reordering, no case folding, no
 * normalization — so legitimate visible content (including non-Latin scripts
 * and emoji, which are assigned and not Cf/Co) is preserved byte-for-byte.
 */
export function sanitizeUntrustedMcpText(input: string): string {
  if (input === "") return input;
  // Fast path: most results contain no stripped code point at all.
  if (!STRIP_RE.test(input)) return input;
  let out = "";
  // Iterate by code point (for…of respects surrogate pairs) so astral-plane
  // private-use / tag characters are matched as single units, not half-pairs.
  for (const ch of input) {
    if (KEEP.has(ch)) {
      out += ch;
      continue;
    }
    if (STRIP_RE.test(ch)) continue;
    out += ch;
  }
  return out;
}
