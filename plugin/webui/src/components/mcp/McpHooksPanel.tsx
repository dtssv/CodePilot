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
        <section className="mcp-hooks-panel">
            <header>
                <h3>MCP Servers & Hooks</h3>
                <button type="button" onClick={() => mcpApi.reload()}>Reload MCP config</button>
            </header>

            <div className="mcp-server-list">
                {servers.length === 0 ? <p className="muted">No `.codepilot/mcp.json` servers configured.</p> : servers.map((server) => (
                    <article key={server.name} className={`mcp-server state-${server.state}`}>
                        <div className="mcp-server-head">
                            <div>
                                <strong>{server.name}</strong>
                                <span>{server.transport} · {server.state}</span>
                            </div>
                            {server.state === 'running' ? (
                                <button type="button" onClick={() => mcpApi.stop(server.name)}>Stop</button>
                            ) : (
                                <button type="button" onClick={() => mcpApi.start(server.name)}>Start</button>
                            )}
                        </div>
                        {server.error && <div className="mcp-error">{server.error}</div>}
                        <ul className="mcp-tool-list">
                            {(server.tools ?? []).map((tool) => (
                                <li key={tool.name}>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={tool.granted}
                                            onChange={(e) => mcpApi.setGranted(server.name, tool.name, e.target.checked)}
                                        />
                                        <code>{tool.name}</code>
                                        <span>{tool.description}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </article>
                ))}
            </div>

            <details className="hooks-editor">
                <summary>Hooks</summary>
                {hooks.map((hook, idx) => (
                    <div key={hook.id} className="hook-row">
                        <input
                            value={hook.event}
                            onChange={(e) => updateHook(idx, { event: e.target.value }, hooks, setHooks)}
                        />
                        <input
                            value={hook.command}
                            onChange={(e) => updateHook(idx, { command: e.target.value }, hooks, setHooks)}
                        />
                        <label>
                            <input
                                type="checkbox"
                                checked={hook.enabled}
                                onChange={(e) => updateHook(idx, { enabled: e.target.checked }, hooks, setHooks)}
                            />
                            enabled
                        </label>
                    </div>
                ))}
                <button
                    type="button"
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
                <button type="button" onClick={() => hooksApi.save(hooks)}>Save hooks</button>
            </details>
        </section>
    );
}

function updateHook(idx: number, patch: Partial<HookItem>, hooks: HookItem[], setHooks: (hooks: HookItem[]) => void) {
    setHooks(hooks.map((h, i) => i === idx ? { ...h, ...patch } : h));
}
