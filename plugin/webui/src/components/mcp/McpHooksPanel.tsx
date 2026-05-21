import { useEffect, useState } from 'react';
import { onPluginEvent } from '../../bridge';
import { useTranslation } from '../../i18n';
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
    const { t } = useTranslation();
    const [servers, setServers] = useState<McpServer[]>(getMcpHooksState().servers);
    const [hooks, setHooks] = useState<HookItem[]>(getMcpHooksState().hooks);
    const [mcpJson, setMcpJson] = useState('');
    const [defaultServerName, setDefaultServerName] = useState('mcp-server');
    const [installBusy, setInstallBusy] = useState(false);
    const [installFlash, setInstallFlash] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        installMcpHooksBridge();
        const off = subscribeMcpHooks((s) => {
            setServers(s.servers);
            setHooks(s.hooks);
        });
        const offInstall = onPluginEvent('mcp.install_result', (raw) => {
            setInstallBusy(false);
            const p = raw as { ok?: boolean; message?: string };
            setInstallFlash({
                ok: !!p.ok,
                text:
                    (p.message ?? '').trim() ||
                    (p.ok ? t('panels.mcp.installOkFallback') : t('panels.mcp.installFailedFallback')),
            });
        });
        mcpApi.list().catch(() => undefined);
        hooksApi.list().catch(() => undefined);
        return () => {
            off();
            offInstall();
        };
    }, [t]);

    const installFromJson = () => {
        setInstallFlash(null);
        setInstallBusy(true);
        const fallback = defaultServerName.trim();
        mcpApi.installJson(mcpJson, fallback || undefined).catch(() => setInstallBusy(false));
    };

    return (
        <section className="panel-base mcp-hooks-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('panels.mcp.title')}</h3>
                    <span className="panel-subtitle">{t('panels.mcp.subtitle')}</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => mcpApi.reload()}>
                    {t('panels.reload')}
                </button>
            </header>

            <div className="panel-section mcp-install-json-section">
                <label>
                    <span>{t('panels.mcp.installSectionTitle')}</span>
                    <p className="panel-card-meta" style={{ margin: '4px 0 8px' }}>
                        {t('panels.mcp.installHint')}
                    </p>
                    <textarea
                        className="panel-input mcp-json-textarea"
                        placeholder={t('panels.mcp.installJsonPlaceholder')}
                        value={mcpJson}
                        spellCheck={false}
                        onChange={(e) => setMcpJson(e.target.value)}
                    />
                </label>
                <div className="mcp-install-json-row">
                    <label style={{ flex: 1, minWidth: 140 }}>
                        <span className="panel-card-meta">{t('panels.mcp.defaultNameLabel')}</span>
                        <input
                            className="panel-input"
                            placeholder={t('panels.mcp.defaultNamePlaceholder')}
                            value={defaultServerName}
                            onChange={(e) => setDefaultServerName(e.target.value)}
                        />
                    </label>
                    <button type="button" className="panel-btn panel-btn-primary" disabled={installBusy} onClick={installFromJson}>
                        {installBusy ? t('panels.mcp.installing') : t('panels.mcp.installFromJson')}
                    </button>
                </div>
                {installFlash && (
                    <div className={`mcp-install-result ${installFlash.ok ? '' : 'mcp-install-result-error'}`}>{installFlash.text}</div>
                )}
            </div>

            <div className="panel-section">
                {servers.length === 0 ? (
                    <p className="panel-empty">{t('panels.mcp.emptyServers')}</p>
                ) : (
                    servers.map((server) => (
                        <article key={server.name} className={`panel-card state-${server.state}`}>
                            <div className="panel-card-header">
                                <div>
                                    <strong>{server.name}</strong>
                                    <span className="panel-card-meta">
                                        {server.transport} · {server.state}
                                    </span>
                                </div>
                                {server.state === 'running' ? (
                                    <button type="button" className="panel-btn panel-btn-danger" onClick={() => mcpApi.stop(server.name)}>
                                        {t('panels.stop')}
                                    </button>
                                ) : (
                                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => mcpApi.start(server.name)}>
                                        {t('panels.start')}
                                    </button>
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
                    ))
                )}
            </div>

            <details className="panel-details">
                <summary>{t('panels.mcp.hooksSummary')}</summary>
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
                            {t('panels.enabled')}
                        </label>
                    </div>
                ))}
                <div className="panel-actions">
                    <button
                        type="button"
                        className="panel-btn"
                        onClick={() =>
                            setHooks([
                                ...hooks,
                                {
                                    id: `hook-${Date.now()}`,
                                    event: 'beforeSubmitPrompt',
                                    command: 'echo "{{message}}"',
                                    enabled: true,
                                    timeoutMs: 30000,
                                },
                            ])
                        }
                    >
                        {t('panels.mcp.addHook')}
                    </button>
                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => hooksApi.save(hooks)}>
                        {t('panels.mcp.saveHooks')}
                    </button>
                </div>
            </details>
        </section>
    );
}

function updateHook(idx: number, patch: Partial<HookItem>, hooks: HookItem[], setHooks: (hooks: HookItem[]) => void) {
    setHooks(hooks.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
}
