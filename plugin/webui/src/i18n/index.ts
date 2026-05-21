/**
 * Lightweight i18n for the plugin WebUI (en / zh).
 * IDE editor actions and context menus stay in English.
 */

import { useEffect, useState } from 'react';
import { en, type Messages } from './locales/en';
import { zh } from './locales/zh';

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'codepilot.ui.locale';

const catalogs: Record<Locale, Messages> = { en, zh };

let locale: Locale = 'en';
let messages: Messages = en;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((l) => l());
}

function getByPath(obj: Record<string, unknown>, path: string): string | undefined {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return typeof cur === 'string' ? cur : undefined;
}

export function normalizeLocale(raw: string | undefined | null): Locale {
    if (!raw) return 'en';
    const lower = raw.trim().toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-')) return 'zh';
    return 'en';
}

export function getLocale(): Locale {
    return locale;
}

export function setLocale(next: Locale, persistLocal = true): void {
    if (next !== 'en' && next !== 'zh') return;
    if (locale === next && messages === catalogs[next]) return;
    locale = next;
    messages = catalogs[next];
    if (persistLocal) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* ignore */
        }
    }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    notify();
}

/** Initialize from localStorage before plugin pushes app_locale. */
export function initLocaleFromStorage(): void {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) setLocale(normalizeLocale(stored), false);
    } catch {
        setLocale('en', false);
    }
}

export function t(key: string, params?: Record<string, string | number>): string {
    const template = getByPath(messages as unknown as Record<string, unknown>, key) ?? key;
    if (!params) return template;
    return Object.entries(params).reduce(
        (s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
        template,
    );
}

export function subscribeLocale(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useTranslation() {
    const [, tick] = useState(0);
    useEffect(() => subscribeLocale(() => tick((n) => n + 1)), []);
    return { t, locale: getLocale() };
}
