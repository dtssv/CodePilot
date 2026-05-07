/**
 * CefMessageRouter bridge for bidirectional communication between
 * the JCEF Web UI and the IntelliJ plugin host.
 *
 * Plugin → Web: window.__codepilot_dispatch(eventType, payload)
 * Web → Plugin: window.cefQuery({ request: JSON.stringify(msg), ... })
 */

export interface BridgeMessage {
    type: string;
    payload: unknown;
}

/** Events dispatched from plugin (Kotlin) to web. */
export type PluginEventType =
    | 'delta'
    | 'tool_call'
    | 'tool_result_ack'
    | 'plan'
    | 'plan_delta'
    | 'task_ledger'
    | 'digest'
    | 'needs_input'
    | 'risk_notice'
    | 'self_check'
    | 'done'
    | 'error'
    | 'skills_activated'
    | 'models_loaded'
    | 'user_message_saved'
    | 'session_list'
    | 'session_switched'
    | 'session_messages';

type EventHandler = (payload: unknown) => void;
const listeners = new Map<string, Set<EventHandler>>();

/** Register a listener for events from the plugin. */
export function onPluginEvent(type: PluginEventType, handler: EventHandler): () => void {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
    return () => listeners.get(type)?.delete(handler);
}

/** Called by the plugin via JS injection: window.__codepilot_dispatch */
function dispatch(type: string, payload: unknown) {
    const handlers = listeners.get(type);
    if (handlers) handlers.forEach((h) => h(payload));
}

// Expose to global for the plugin to call
(window as unknown as Record<string, unknown>).__codepilot_dispatch = dispatch;

/** Send a message from web to the plugin via CefMessageRouter. */
export function sendToPlugin(type: string, payload: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
        const msg = JSON.stringify({ type, payload });
        const cef = (window as unknown as Record<string, unknown>).cefQuery as
            | ((args: {
                request: string;
                onSuccess: (r: string) => void;
                onFailure: (code: number, msg: string) => void;
            }) => void)
            | undefined;
        if (cef) {
            cef({
                request: msg,
                onSuccess: resolve,
                onFailure: (_code, errMsg) => reject(new Error(errMsg)),
            });
        } else {
            // Fallback for dev mode (no CEF)
            console.log('[bridge:toPlugin]', type, payload);
            resolve('ok');
        }
    });
}