import { Fragment } from 'react';
import type { AppTab } from '../../types/appTabs';
import { APP_TAB_DEFS, type AppTabGroup } from '../../config/appTabConfig';
import { useTranslation } from '../../i18n';
import { useMcpConfirmRequest } from '../../state/mcpConfirm';

export interface AppShellNavProps {
    activeTab: AppTab;
    theme: 'dark' | 'light' | 'high-contrast';
    pendingMemoryCount: number;
    bgActiveCount: number;
    onTabChange: (tab: AppTab) => void;
    onThemeCycle: () => void;
}

const GROUP_LABEL_KEYS: Record<AppTabGroup, string> = {
    work: 'nav.groupWork',
    tools: 'nav.groupTools',
    monitor: 'nav.groupMonitor',
};

function tabsInGroup(group: AppTabGroup) {
    return APP_TAB_DEFS.filter((t) => t.group === group);
}

export function AppShellNav({
    activeTab,
    theme,
    pendingMemoryCount,
    bgActiveCount,
    onTabChange,
    onThemeCycle,
}: AppShellNavProps) {
    const { t } = useTranslation();
    const mcpPending = useMcpConfirmRequest();

    const badgeFor = (tab: AppTab) => {
        if (tab === 'rules' && pendingMemoryCount > 0) return pendingMemoryCount;
        if (tab === 'background' && bgActiveCount > 0) return bgActiveCount;
        if (tab === 'integrations' && mcpPending) return 1;
        return 0;
    };

    const groups = ['work', 'tools', 'monitor'] as const;

    return (
        <nav className="app-shell-nav" aria-label="CodePilot sections">
            <div className="app-shell-nav-inner">
                {groups.map((group, idx) => (
                    <Fragment key={group}>
                        {idx > 0 && <div className="app-shell-nav-sep" aria-hidden />}
                        <div className="app-shell-nav-chunk" role="group" aria-label={t(GROUP_LABEL_KEYS[group])}>
                            {tabsInGroup(group).map((def) => {
                                const badge = badgeFor(def.id);
                                const active = activeTab === def.id;
                                const label = t(def.labelKey);
                                return (
                                    <button
                                        key={def.id}
                                        type="button"
                                        className={active ? 'app-nav-btn app-nav-btn-active' : 'app-nav-btn'}
                                        onClick={() => onTabChange(def.id)}
                                        title={label}
                                        aria-current={active ? 'page' : undefined}
                                    >
                                        <span className="app-nav-icon" aria-hidden>
                                            {def.icon}
                                        </span>
                                        <span className="app-nav-label">{label}</span>
                                        {badge > 0 && <span className="app-nav-badge">{badge}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </Fragment>
                ))}
            </div>
            <div className="app-shell-nav-toolbar">
                <button
                    type="button"
                    className="app-nav-btn app-nav-theme"
                    onClick={onThemeCycle}
                    title={t('nav.cycleTheme')}
                    aria-label={t('nav.cycleTheme')}
                >
                    {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐'}
                </button>
            </div>
        </nav>
    );
}
