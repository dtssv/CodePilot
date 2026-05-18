import { useEffect, useState } from 'react';
import {
    getMcpHooksState,
    hooksApi,
    installMcpHooksBridge,
    mcpApi,
    subscribeMcpHooks,
    type HookItem,
    type McpServer,
} from '../../state/mcpHooks';

export function McpHooksPanel() {
    const [servers, setServers] = useState<McpServer[]>(getMcpHooksState().servers);
    const [hooks, setHooks] = useState<HookItem[]>(getMcpHooksState().hooks);

    useEffect(() => {
        installMcpHooksBridge();
        const off = subscribeMcpHooks((s) => {
            setServers(s.servers);
            setHooks(s.hooks);
        });
        mcpApi.list().catch(() => undefined);
        hooksApi.list().catch(() => undefined);
        return off;
    }, []);

    return (
        <section className="panel-base mcp-hooks-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">🔌 MCP Servers & Hooks</h3>
                    <span className="panel-subtitle">Model Context Protocol integration</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => mcpApi.reload()}>Reload</button>
            </header>

            <div className="panel-section">
                {servers.length === 0 ? <p className="panel-empty">No `.codepilot/mcp.json` servers configured.</p> : servers.map((server) => (
                    <article key={server.name} className={`panel-card state-${server.state}`}>
                        <div className="panel-card-header">
                            <div>
                                <strong>{server.name}</strong>
                                <span className="panel-card-meta">{server.transport} · {server.state}</span>
                            </div>
                            {server.state === 'running' ? (
                                <button type="button" className="panel-btn panel-btn-danger" onClick={() => mcpApi.stop(server.name)}>Stop</button>
                            ) : (
                                <button type="button" className="panel-btn panel-btn-primary" onClick={() => mcpApi.start(server.name)}>Start</button>
                            )}
                        </div>
                        {server.error && <div className="panel-error">{server.error}</div>}
                        <ul className="panel-list panel-list-compact">
                            {(server.tools ?? []).map((tool) => (
                                <li key={tool.name}>
                                    <label className="panel-check-row">
                                        <input
                                            type="checkbox"
                                            checked={tool.granted}
                                            onChange={(e) => mcpApi.setGranted(server.name, tool.name, e.target.checked)}
                                        />
                                        <code>{tool.name}</code>
                                        <span className="panel-card-meta">{tool.description}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </article>
                ))}
            </div>

            <details className="panel-details">
                <summary>Hooks</summary>
                {hooks.map((hook, idx) => (
                    <div key={hook.id} className="panel-row">
                        <input
                            className="panel-input"
                            value={hook.event}
                            onChange={(e) => updateHook(idx, { event: e.target.value }, hooks, setHooks)}
                        />
                        <input
                            className="panel-input"
                            value={hook.command}
                            onChange={(e) => updateHook(idx, { command: e.target.value }, hooks, setHooks)}
                        />
                        <label className="panel-check-row">
                            <input
                                type="checkbox"
                                checked={hook.enabled}
                                onChange={(e) => updateHook(idx, { enabled: e.target.checked }, hooks, setHooks)}
                            />
                            enabled
                        </label>
                    </div>
                ))}
                <div className="panel-actions">
                    <button
                        type="button"
                        className="panel-btn"
                        onClick={() => setHooks([...hooks, {
                            id: `hook-${Date.now()}`,
                            event: 'beforeSubmitPrompt',
                            command: 'echo "{{message}}"',
                            enabled: true,
                            timeoutMs: 30000,
                        }])}
                    >
                        Add hook
                    </button>
                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => hooksApi.save(hooks)}>Save hooks</button>
                </div>
            </details>
        </section>
    );
}

function updateHook(idx: number, patch: Partial<HookItem>, hooks: HookItem[], setHooks: (hooks: HookItem[]) => void) {
    setHooks(hooks.map((h, i) => i === idx ? { ...h, ...patch } : h));
}
