import { onPluginEvent, sendToPlugin } from '../bridge';
import { normalizeLocale, setLocale, type Locale } from '../i18n';

export function installLocaleBridge(): () => void {
    return onPluginEvent('app_locale', (payload) => {
        const raw = (payload as { locale?: string })?.locale;
        setLocale(normalizeLocale(raw));
    });
}

export function changePluginLocale(locale: Locale): void {
    setLocale(locale);
    sendToPlugin('set_preferred_locale', { locale }).catch(() => undefined);
}
