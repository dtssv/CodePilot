import { sendToPlugin } from '../bridge';

let lastPermAsk = 0;

async function ensurePermission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
    if (Date.now() - lastPermAsk < 60_000) return Notification.permission;
    lastPermAsk = Date.now();
    return Notification.requestPermission();
}

export async function notify(title: string, body: string) {
    if (typeof document !== 'undefined' && document.hasFocus()) return;
    try {
        const permission = await ensurePermission();
        if (permission === 'granted') {
            new Notification(title, { body });
            return;
        }
    } catch {
        // Fall through to IDE notification.
    }
    sendToPlugin('ui.notify', { title, body }).catch(() => undefined);
}
