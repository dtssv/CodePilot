/**
 * App shell: IDE theme sync and document root theming.
 */

import { useEffect } from 'react';
import { onPluginEvent } from '../bridge';

export type AppTheme = 'dark' | 'light' | 'high-contrast';

export function installIdeThemeBridge(setTheme: (t: AppTheme) => void): () => void {
    return onPluginEvent('ide_theme', (payload) => {
        const ideTheme = (payload as { theme: string }).theme;
        if (ideTheme === 'light') setTheme('light');
        else if (ideTheme === 'high-contrast') setTheme('high-contrast');
        else setTheme('dark');
    });
}

export function useDocumentTheme(theme: AppTheme): void {
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);
}
