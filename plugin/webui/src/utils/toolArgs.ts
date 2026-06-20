/** Normalize tool args from envelope / hydrate (object or JSON string). */
export function normalizeToolArgs(raw: unknown): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) return {};
        if (t.startsWith('{') || t.startsWith('[')) {
            try {
                const parsed = JSON.parse(t) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                /* ignore */
            }
        }
        return {};
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    return {};
}

/** Parse tool.result when stored as a JSON string. */
export function parseToolResultPayload(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const t = raw.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return raw;
    try {
        return JSON.parse(t) as unknown;
    } catch {
        return raw;
    }
}
