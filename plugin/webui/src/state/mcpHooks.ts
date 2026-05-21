import { onPluginEvent, sendToPlugin } from '../bridge';

export interface McpTool {
    name: string;
    description?: string;
    granted: boolean;
}

export interface McpServer {
    name: string;
    state: 'stopped' | 'starting' | 'running' | 'error';
    transport: string;
    tools: McpTool[];
    error?: string;
    lastStartedAt?: number;
}

export interface HookItem {
    id: string;
    event: string;
    command: string;
    enabled: boolean;
    timeoutMs: number;
}

interface State { servers: McpServer[]; hooks: HookItem[] }
let state: State = { servers: [], hooks: [] };
const listeners = new Set<(s: State) => void>();

function setState(next: Partial<State>) {
    state = { ...state, ...next };
    listeners.forEach((l) => l(state));
}

let installed = false;
export function installMcpHooksBridge() {
    if (installed) return;
    installed = true;
    onPluginEvent('envelope', (raw) => {
        const env = raw as { type?: string; payload?: Record<string, unknown> };
        if (env.type === 'mcp.status') setState({ servers: (env.payload?.servers as McpServer[]) ?? [] });
    });
    onPluginEvent('mcp.response', (raw) => {
        const r = raw as { servers?: McpServer[] };
        if (r.servers) setState({ servers: r.servers });
    });
    onPluginEvent('hooks.response', (raw) => {
        const r = raw as { hooks?: HookItem[] };
        if (r.hooks) setState({ hooks: r.hooks });
    });
}

export function getMcpHooksState() { return state; }
export function subscribeMcpHooks(listener: (s: State) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const mcpApi = {
    list: () => sendToPlugin('mcp.list_servers', {}),
    reload: () => sendToPlugin('mcp.reload', {}),
    start: (name: string) => sendToPlugin('mcp.start', { name }),
    stop: (name: string) => sendToPlugin('mcp.stop', { name }),
    setGranted: (server: string, tool: string, granted: boolean) =>
        sendToPlugin('mcp.set_granted', { server, tool, granted }),
    editConfig: (content: string) => sendToPlugin('mcp.edit_config', { content }),
    installJson: (json: string, defaultName?: string) =>
        sendToPlugin('mcp.install_json', { json, ...(defaultName ? { defaultName } : {}) }),
};

export const hooksApi = {
    list: () => sendToPlugin('hooks.list', {}),
    save: (hooks: HookItem[]) => sendToPlugin('hooks.save', { hooks }),
};
