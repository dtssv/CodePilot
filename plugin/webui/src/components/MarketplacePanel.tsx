import { useCallback, useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import { useTranslation } from '../i18n';

interface SkillEntry {
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
    category: string;
    scope: 'project' | 'global';
    installed: boolean;
    enabled: boolean;
}

type CategoryFilter = 'all' | 'language' | 'framework' | 'action' | 'utility';

const PAGE_SIZE = 20;

export function MarketplacePanel() {
    const { t } = useTranslation();
    const [skills, setSkills] = useState<SkillEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [installing, setInstalling] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const [registries, setRegistries] = useState<{ url: string; name: string }[]>([]);
    const [newRegUrl, setNewRegUrl] = useState('');
    const [newRegName, setNewRegName] = useState('');
    const [showRegPanel, setShowRegPanel] = useState(false);

    useEffect(() => {
        const saved = localStorage.getItem('codepilot_registries');
        if (saved) {
            try {
                setRegistries(JSON.parse(saved));
            } catch {
                /* ignore */
            }
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('codepilot_registries', JSON.stringify(registries));
    }, [registries]);

    useEffect(() => {
        if (!toast) return;
        const id = window.setTimeout(() => setToast(null), 5000);
        return () => window.clearTimeout(id);
    }, [toast]);

    const refreshSkills = useCallback(
        (targetPage = page) => {
            setLoading(true);
            sendToPlugin('skill_list', { registries, page: targetPage, pageSize: PAGE_SIZE }).catch(() => setLoading(false));
        },
        [registries, page],
    );

    useEffect(() => {
        refreshSkills(page);
        const unsubList = onPluginEvent('skill_list_result', (payload) => {
            const data = payload as {
                skills: SkillEntry[];
                page?: number;
                total?: number;
                hasMore?: boolean;
            };
            setSkills(data.skills || []);
            setPage(data.page ?? page);
            setTotal(data.total ?? data.skills?.length ?? 0);
            setHasMore(data.hasMore ?? false);
            setLoading(false);
        });
        const unsubErr = onPluginEvent('marketplace.error', (payload) => {
            const msg = (payload as { message?: string }).message ?? t('marketplace.errorFallback');
            setToast(msg);
            setLoading(false);
        });
        return () => {
            unsubList();
            unsubErr();
        };
    }, [refreshSkills, page, t]);

    const filteredSkills = skills.filter((s) => {
        if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
        if (
            searchQuery &&
            !s.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
            !s.description.toLowerCase().includes(searchQuery.toLowerCase())
        ) {
            return false;
        }
        return true;
    });

    const handleInstall = useCallback(
        (skill: SkillEntry) => {
            setInstalling(skill.id);
            sendToPlugin('skill_install', { id: skill.id, version: skill.version, scope: skill.scope, registries, page, pageSize: PAGE_SIZE }).finally(
                () => setInstalling(null),
            );
        },
        [registries, page],
    );

    const handleUninstall = useCallback(
        (skill: SkillEntry) => {
            sendToPlugin('skill_uninstall', { id: skill.id, version: skill.version, registries, page, pageSize: PAGE_SIZE }).catch(() => undefined);
        },
        [registries, page],
    );

    const handleToggle = useCallback(
        (skill: SkillEntry, enabled: boolean) => {
            sendToPlugin('skill_toggle', { id: skill.id, version: skill.version, enabled, registries, page, pageSize: PAGE_SIZE }).catch(() => undefined);
        },
        [registries, page],
    );

    const categories: { key: CategoryFilter; labelKey: string }[] = [
        { key: 'all', labelKey: 'marketplace.categories.all' },
        { key: 'language', labelKey: 'marketplace.categories.language' },
        { key: 'framework', labelKey: 'marketplace.categories.framework' },
        { key: 'action', labelKey: 'marketplace.categories.action' },
        { key: 'utility', labelKey: 'marketplace.categories.utility' },
    ];

    const categoryColors: Record<string, string> = {
        language: '#4fc3f7',
        framework: '#ab47bc',
        action: '#66bb6a',
        utility: '#ffa726',
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="marketplace-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {toast && (
                <div className="marketplace-toast" role="alert">
                    {toast}
                    <button type="button" onClick={() => setToast(null)} aria-label={t('common.dismiss')}>
                        ×
                    </button>
                </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '14px' }}>{t('marketplace.title')}</h3>
                <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                        type="button"
                        onClick={() => setShowRegPanel(!showRegPanel)}
                        style={{
                            fontSize: '12px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            background: 'transparent',
                            border: '1px solid var(--vscode-editorWidget-border, #444)',
                            borderRadius: '4px',
                            color: 'inherit',
                        }}
                    >
                        {t('marketplace.skillRegistries')}
                    </button>
                    <button
                        type="button"
                        onClick={() => refreshSkills(page)}
                        style={{
                            fontSize: '12px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            background: 'transparent',
                            border: '1px solid var(--vscode-editorWidget-border, #444)',
                            borderRadius: '4px',
                            color: 'inherit',
                        }}
                    >
                        {t('common.refresh')}
                    </button>
                </div>
            </div>

            {showRegPanel && (
                <div
                    style={{
                        padding: '8px',
                        borderRadius: '6px',
                        border: '1px solid var(--vscode-editorWidget-border, #444)',
                        background: 'var(--vscode-editor-background, #1a1a2e)',
                    }}
                >
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>{t('marketplace.skillRegistries')}</div>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                        <input
                            type="text"
                            placeholder={t('marketplace.registryUrlPlaceholder')}
                            value={newRegUrl}
                            onChange={(e) => setNewRegUrl(e.target.value)}
                            style={{
                                flex: 2,
                                padding: '4px 8px',
                                fontSize: '11px',
                                background: 'var(--vscode-input-background, #1e1e2e)',
                                border: '1px solid var(--vscode-editorWidget-border, #444)',
                                borderRadius: '4px',
                                color: 'inherit',
                                boxSizing: 'border-box',
                            }}
                        />
                        <input
                            type="text"
                            placeholder={t('marketplace.namePlaceholder')}
                            value={newRegName}
                            onChange={(e) => setNewRegName(e.target.value)}
                            style={{
                                flex: 1,
                                padding: '4px 8px',
                                fontSize: '11px',
                                background: 'var(--vscode-input-background, #1e1e2e)',
                                border: '1px solid var(--vscode-editorWidget-border, #444)',
                                borderRadius: '4px',
                                color: 'inherit',
                                boxSizing: 'border-box',
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => {
                                if (newRegUrl.trim()) {
                                    setRegistries((prev) => [...prev, { url: newRegUrl.trim(), name: newRegName.trim() || newRegUrl.trim() }]);
                                    setNewRegUrl('');
                                    setNewRegName('');
                                    setPage(1);
                                }
                            }}
                            style={{
                                fontSize: '11px',
                                padding: '4px 10px',
                                cursor: 'pointer',
                                background: 'var(--vscode-button-background, #0078d4)',
                                border: 'none',
                                color: '#fff',
                                borderRadius: '4px',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {t('marketplace.add')}
                        </button>
                    </div>
                    {registries.length === 0 && (
                        <div style={{ opacity: 0.5, fontSize: '11px', textAlign: 'center', padding: '8px' }}>{t('marketplace.noRegistries')}</div>
                    )}
                    {registries.map((reg, idx) => (
                        <div
                            key={idx}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '4px 0',
                                borderBottom: idx < registries.length - 1 ? '1px solid #333' : 'none',
                            }}
                        >
                            <span style={{ fontSize: '11px', fontWeight: 600, minWidth: '60px' }}>{reg.name}</span>
                            <span style={{ fontSize: '11px', opacity: 0.6, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {reg.url}
                            </span>
                            <button
                                type="button"
                                onClick={() => setRegistries((prev) => prev.filter((_, i) => i !== idx))}
                                style={{
                                    fontSize: '10px',
                                    padding: '2px 6px',
                                    cursor: 'pointer',
                                    background: 'transparent',
                                    border: '1px solid #c62828',
                                    color: '#ef5350',
                                    borderRadius: '3px',
                                }}
                            >
                                {t('marketplace.remove')}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <input
                type="text"
                placeholder={t('marketplace.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: '13px',
                    background: 'var(--vscode-input-background, #1e1e2e)',
                    border: '1px solid var(--vscode-editorWidget-border, #444)',
                    borderRadius: '4px',
                    color: 'inherit',
                    boxSizing: 'border-box',
                }}
            />

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {categories.map((cat) => (
                    <button
                        key={cat.key}
                        type="button"
                        onClick={() => setCategoryFilter(cat.key)}
                        style={{
                            fontSize: '11px',
                            padding: '3px 10px',
                            cursor: 'pointer',
                            borderRadius: '12px',
                            border:
                                categoryFilter === cat.key
                                    ? '1px solid var(--vscode-button-background, #0078d4)'
                                    : '1px solid var(--vscode-editorWidget-border, #444)',
                            background: categoryFilter === cat.key ? 'var(--vscode-button-background, #0078d4)' : 'transparent',
                            color: categoryFilter === cat.key ? '#fff' : 'inherit',
                        }}
                    >
                        {t(cat.labelKey)}
                    </button>
                ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {loading && (
                    <div style={{ opacity: 0.5, fontSize: '12px', textAlign: 'center', padding: '20px' }}>{t('marketplace.loading')}</div>
                )}
                {!loading && filteredSkills.length === 0 && (
                    <div style={{ opacity: 0.5, fontSize: '12px', textAlign: 'center', padding: '20px' }}>{t('marketplace.empty')}</div>
                )}
                {filteredSkills.map((skill) => (
                    <div
                        key={skill.id}
                        style={{
                            padding: '10px 12px',
                            borderRadius: '6px',
                            background: 'var(--vscode-editor-background, #1a1a2e)',
                            border: '1px solid var(--vscode-editorWidget-border, #444)',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{skill.name}</span>
                                    <span
                                        style={{
                                            fontSize: '10px',
                                            padding: '1px 6px',
                                            borderRadius: '3px',
                                            background: categoryColors[skill.category] || '#666',
                                            color: '#fff',
                                        }}
                                    >
                                        {skill.category}
                                    </span>
                                </div>
                                <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px' }}>{skill.description}</div>
                                <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '2px' }}>
                                    v{skill.version} · {skill.author}
                                </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
                                {!skill.installed ? (
                                    <button
                                        type="button"
                                        disabled={installing === skill.id}
                                        onClick={() => handleInstall(skill)}
                                        style={{
                                            fontSize: '11px',
                                            padding: '3px 10px',
                                            cursor: 'pointer',
                                            background: 'var(--vscode-button-background, #0078d4)',
                                            border: 'none',
                                            color: '#fff',
                                            borderRadius: '4px',
                                        }}
                                    >
                                        {installing === skill.id ? t('marketplace.installing') : t('marketplace.install')}
                                    </button>
                                ) : (
                                    <>
                                        <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <input type="checkbox" checked={skill.enabled} onChange={(e) => handleToggle(skill, e.target.checked)} />
                                            {t('marketplace.enabled')}
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => handleUninstall(skill)}
                                            style={{
                                                fontSize: '11px',
                                                padding: '3px 8px',
                                                cursor: 'pointer',
                                                background: 'transparent',
                                                border: '1px solid #c62828',
                                                color: '#ef5350',
                                                borderRadius: '4px',
                                            }}
                                        >
                                            {t('marketplace.uninstall')}
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {!loading && total > PAGE_SIZE && (
                <div className="marketplace-pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span>{t('marketplace.pageInfo', { total, page, pages: totalPages })}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button type="button" disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); refreshSkills(p); }}>
                            {t('marketplace.prev')}
                        </button>
                        <button type="button" disabled={!hasMore} onClick={() => { const p = page + 1; setPage(p); refreshSkills(p); }}>
                            {t('marketplace.next')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
