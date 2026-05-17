/**
 * Renders tool arguments as a syntax-friendly JSON block.
 *
 * Kept dependency-free (no syntax highlighter import); the chat panel's existing
 * `highlight.js` is reserved for code blocks inside text content.
 */
export function ToolArgsView({ args }: { args: unknown }) {
    let text: string;
    try {
        text = JSON.stringify(args, null, 2);
    } catch {
        text = String(args);
    }
    // Guardrail: arguments can occasionally contain very long inline content
    // (e.g. patches). Truncate display only — full content remains in the store.
    const truncated = text.length > 8000;
    const display = truncated ? `${text.slice(0, 8000)}\n…[truncated ${text.length - 8000} chars]` : text;
    return <pre className="tool-args-json">{display}</pre>;
}
