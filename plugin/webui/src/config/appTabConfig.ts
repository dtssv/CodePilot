import type { AppTab } from '../types/appTabs';
import { hooksApi, mcpApi } from '../state/mcpHooks';
import { memoryApi, rulesApi } from '../state/rulesMemory';
import { requestCodebaseStatus } from '../state/codebase';
import { shellPolicyApi } from '../state/shellPolicy';
import { sendToPlugin } from '../bridge';

export type AppTabGroup = 'work' | 'tools' | 'monitor';

export interface AppTabDef {
    id: AppTab;
    /** i18n key under `nav.*` */
    labelKey: string;
    icon: string;
    group: AppTabGroup;
    /** Prefetch / refresh when the tab becomes active. */
    onEnter?: () => void;
}

export const APP_TAB_DEFS: AppTabDef[] = [
    { id: 'chat', labelKey: 'nav.chat', icon: '💬', group: 'work' },
    { id: 'composer', labelKey: 'nav.composer', icon: '✏️', group: 'work' },
    {
        id: 'codebase',
        labelKey: 'nav.codebase',
        icon: '📦',
        group: 'tools',
        onEnter: () => {
            requestCodebaseStatus().catch(() => undefined);
        },
    },
    {
        id: 'rules',
        labelKey: 'nav.rules',
        icon: '📜',
        group: 'tools',
        onEnter: () => {
            rulesApi.list().catch(() => undefined);
            memoryApi.list().catch(() => undefined);
        },
    },
    { id: 'notepads', labelKey: 'nav.notepads', icon: '📝', group: 'tools', onEnter: () => sendToPlugin('notepad_list', {}).catch(() => undefined) },
    { id: 'templates', labelKey: 'nav.templates', icon: '📋', group: 'tools', onEnter: () => sendToPlugin('templates.list', {}).catch(() => undefined) },
    {
        id: 'integrations',
        labelKey: 'nav.integrations',
        icon: '🧩',
        group: 'tools',
        onEnter: () => {
            sendToPlugin('skill_list', { page: 1, pageSize: 20 }).catch(() => undefined);
            mcpApi.list().catch(() => undefined);
            hooksApi.list().catch(() => undefined);
        },
    },
    {
        id: 'shell',
        labelKey: 'nav.shell',
        icon: '⌨️',
        group: 'tools',
        onEnter: () => shellPolicyApi.get().catch(() => undefined),
    },
    { id: 'tab', labelKey: 'nav.tab', icon: '↹', group: 'tools', onEnter: () => sendToPlugin('tab.get_stats', {}).catch(() => undefined) },
    { id: 'usage', labelKey: 'nav.usage', icon: '📊', group: 'monitor', onEnter: () => sendToPlugin('usage.get', {}).catch(() => undefined) },
    { id: 'background', labelKey: 'nav.background', icon: '🤖', group: 'monitor', onEnter: () => sendToPlugin('bg.list', {}).catch(() => undefined) },
    { id: 'export', labelKey: 'nav.export', icon: '📤', group: 'monitor' },
    { id: 'console', labelKey: 'nav.console', icon: '🖥️', group: 'monitor' },
];

const TAB_BY_ID = new Map(APP_TAB_DEFS.map((d) => [d.id, d]));

export function getAppTabDef(tab: AppTab): AppTabDef | undefined {
    return TAB_BY_ID.get(tab);
}

export function runAppTabEnter(tab: AppTab): void {
    getAppTabDef(tab)?.onEnter?.();
}
