/**
 * Auth + model catalog plugin events.
 */

import { onPluginEvent, sendToPlugin } from '../bridge';

export interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
    tier?: 'FAST' | 'DEFAULT' | 'THINKING' | 'PREMIUM';
    capabilities?: string[];
}

export interface ModelRouteInfo {
    name?: string;
    tier?: string;
    reason?: string;
    maxMode?: boolean;
    thinkingMode?: string;
    /** openai-reasoning | anthropic-extra */
    thinkingTransport?: string;
}

export interface ModelAuthBridgeHandlers {
    setAuthenticated: (v: boolean) => void;
    setModels: (models: ModelOption[]) => void;
    setSelectedModelId: (id: string) => void;
    setLastRoute: (route: ModelRouteInfo | null) => void;
    getSelectedModelId: () => string;
}

export function installModelAuthBridge(h: ModelAuthBridgeHandlers): () => void {
    sendToPlugin('check_auth', {}).catch(() => undefined);

    const unsubs = [
        onPluginEvent('auth_state', (payload) => {
            const state = payload as { authenticated: boolean };
            h.setAuthenticated(state.authenticated);
        }),
        onPluginEvent('auth_login_result', (payload) => {
            const result = payload as { success: boolean };
            if (result.success) {
                h.setAuthenticated(true);
                sendToPlugin('fetch_models', {}).catch(() => undefined);
                sendToPlugin('list_sessions', {}).catch(() => undefined);
            }
        }),
        onPluginEvent('models_loaded', (payload) => {
            const data = payload as { system?: ModelOption[]; custom?: ModelOption[] };
            const all: ModelOption[] = [
                ...(data.system || []).map((m) => ({ ...m, type: 'system' as const })),
                ...(data.custom || []).map((m) => ({ ...m, type: 'custom' as const })),
            ];
            h.setModels(all);
            if (!h.getSelectedModelId() && all.length > 0) {
                h.setSelectedModelId('auto');
            }
        }),
        onPluginEvent('model.routed', (payload) => {
            h.setLastRoute(payload as ModelRouteInfo);
        }),
    ];
    return () => unsubs.forEach((u) => u());
}

export function bootstrapAuthenticatedSession(): void {
    sendToPlugin('fetch_models', {}).catch(() => undefined);
    sendToPlugin('list_sessions', {}).catch(() => undefined);
}
