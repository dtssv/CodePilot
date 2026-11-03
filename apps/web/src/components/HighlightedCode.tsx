import { useEffect, useState } from "react";

import { highlightCode, resolveLang } from "../state/highlighter.js";

/**
 * Render `code` with Shiki syntax highlighting, falling back to a plain <pre>
 * while loading or when the language is unsupported. Highlighting runs
 * asynchronously; a stale result is cleared when inputs change.
 */
export function HighlightedCode({
  code,
  lang,
  className = "",
  preClassName = "",
}: {
  code: string;
  lang?: string;
  /** Applied to the wrapper that holds Shiki's <pre>. */
  className?: string;
  /** Applied to the plain-text fallback <pre>. */
  preClassName?: string;
}): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (resolveLang(lang) === null) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void highlightCode(code, lang).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className={`cp-code ${className}`}
        // Shiki emits only <pre>/<code>/<span> with escaped text and inline
        // token styles — see state/highlighter.ts for the CSP/safety rationale.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted Shiki HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <pre className={preClassName}>{code}</pre>;
}
