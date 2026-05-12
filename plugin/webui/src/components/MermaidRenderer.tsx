import { useEffect, useRef, useState } from 'react';

/**
 * MermaidRenderer: Renders Mermaid diagram syntax as SVG in chat messages.
 *
 * When the LLM generates Mermaid code blocks (```mermaid), this component
 * renders them as interactive SVG diagrams instead of raw code.
 *
 * Features:
 * - Client-side Mermaid rendering via mermaid.js
 * - Fallback to raw code on render failure
 * - Copy diagram source button
 * - Zoom controls for large diagrams
 */
interface MermaidRendererProps {
    source: string;
    theme?: 'dark' | 'light' | 'default';
}

export function MermaidRenderer({ source, theme = 'default' }: MermaidRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1);
    const [showSource, setShowSource] = useState(false);

    useEffect(() => {
        let cancelled = false;
        renderMermaid(source, theme).then(result => {
            if (cancelled) return;
            if (result.svg) {
                setSvg(result.svg);
                setError(null);
            } else {
                setSvg(null);
                setError(result.error || 'Render failed');
            }
        }).catch(() => {
            if (!cancelled) setError('Mermaid not loaded');
        });
        return () => { cancelled = true; };
    }, [source, theme]);

    return (
        <div style={{ position: 'relative', margin: '8px 0' }}>
            {/* Rendered SVG diagram */}
            {svg && !showSource && (
                <div style={{ overflow: 'auto', maxHeight: '500px', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '6px', background: 'var(--vscode-editor-background, #1e1e2e)' }}>
                    <div
                        ref={containerRef}
                        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', transition: 'transform 0.15s' }}
                        dangerouslySetInnerHTML={{ __html: svg }}
                    />
                </div>
            )}
            {/* Raw source code view */}
            {(showSource || (error && !svg)) && (
                <pre style={{ fontSize: '12px', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', padding: '8px', background: 'var(--vscode-textCodeBlock-background, #1a1a2e)', borderRadius: '6px', border: '1px solid var(--vscode-editorWidget-border, #444)' }}>
                    {source}
                </pre>
            )}
            {/* Error message */}
            {error && svg === null && (
                <div style={{ fontSize: '11px', color: '#ef5350', padding: '4px 8px' }}>
                    Diagram render error: {error}
                </div>
            )}
            {/* Toolbar */}
            <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                {svg && (
                    <>
                        <button onClick={() => setZoom(z => Math.min(z + 0.2, 3))}
                            style={{ padding: '2px 8px', fontSize: '10px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '3px', color: 'inherit', cursor: 'pointer' }}>
                            Zoom +
                        </button>
                        <button onClick={() => setZoom(z => Math.max(z - 0.2, 0.4))}
                            style={{ padding: '2px 8px', fontSize: '10px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '3px', color: 'inherit', cursor: 'pointer' }}>
                            Zoom -
                        </button>
                        <button onClick={() => setZoom(1)}
                            style={{ padding: '2px 8px', fontSize: '10px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '3px', color: 'inherit', cursor: 'pointer' }}>
                            Reset
                        </button>
                    </>
                )}
                <button onClick={() => setShowSource(!showSource)}
                    style={{ padding: '2px 8px', fontSize: '10px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '3px', color: 'inherit', cursor: 'pointer' }}>
                    {showSource ? 'Diagram' : 'Source'}
                </button>
                <button onClick={() => navigator.clipboard?.writeText(source)}
                    style={{ padding: '2px 8px', fontSize: '10px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '3px', color: 'inherit', cursor: 'pointer' }}>
                    Copy
                </button>
            </div>
        </div>
    );
}

// ─── Mermaid Rendering ──────────────────────────────────────────────

interface RenderResult {
    svg: string | null;
    error?: string;
}

// Singleton mermaid module loader
let mermaidModule: any = null;
let mermaidLoadAttempted = false;

async function loadMermaid(): Promise<any> {
    if (mermaidModule) return mermaidModule;
    if (mermaidLoadAttempted) return null;

    mermaidLoadAttempted = true;
    try {
        // Try to load mermaid from CDN
        // In a JCEF environment, this will work if internet is available
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
        script.async = true;

        return new Promise((resolve) => {
            script.onload = () => {
                mermaidModule = (window as any).mermaid;
                if (mermaidModule) {
                    mermaidModule.initialize({
                        startOnLoad: false,
                        theme: 'dark',
                        securityLevel: 'loose',
                    });
                }
                resolve(mermaidModule);
            };
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        });
    } catch {
        return null;
    }
}

async function renderMermaid(source: string, _theme: string): Promise<RenderResult> {
    const mermaid = await loadMermaid();
    if (!mermaid) {
        return { svg: null, error: 'Mermaid library not available' };
    }

    try {
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await mermaid.render(id, source.trim());
        return { svg };
    } catch (e: any) {
        return { svg: null, error: e.message || 'Render error' };
    }
}

export default MermaidRenderer;