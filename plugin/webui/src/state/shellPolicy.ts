import { onPluginEvent, sendToPlugin } from '../bridge';

export interface ShellRule { pattern: string; action: 'allow' | 'deny' | 'ask' }
export interface ShellPolicyState { defaultAction: 'allow' | 'deny' | 'ask'; rules: ShellRule[] }

const DEFAULT: ShellPolicyState = { defaultAction: 'ask', rules: [] };
let state = DEFAULT;
const listeners = new Set<(s: ShellPolicyState) => void>();

function setState(next: ShellPolicyState) {
    state = next;
    listeners.forEach((l) => l(state));
}

let installed = false;
export function installShellPolicyBridge() {
    if (installed) return;
    installed = true;
    onPluginEvent('shell.policy_response', (raw) => {
        const p = raw as Partial<ShellPolicyState>;
        setState({
            defaultAction: p.defaultAction ?? 'ask',
            rules: Array.isArray(p.rules) ? p.rules : [],
        });
    });
}

export function getShellPolicy() { return state; }
export function subscribeShellPolicy(listener: (s: ShellPolicyState) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const shellPolicyApi = {
    get: () => sendToPlugin('shell.policy_get', {}),
    save: (policy: ShellPolicyState) => sendToPlugin('shell.policy_save', policy),
};
