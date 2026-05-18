/**
 * MCP tool execution confirmation (plugin → WebUI modal → mcp.confirm.response).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

export interface McpConfirmRequest {
    confirmId: string;
    serverId: string;
    toolName: string;
    fullName: string;
    argsPreview?: string;
}

let pending: McpConfirmRequest | null = null;
const listeners = new Set<(req: McpConfirmRequest | null) => void>();

function notify() {
    listeners.forEach((l) => l(pending));
}

export function installMcpConfirmBridge(): () => void {
    return onPluginEvent('mcp.confirm.request', (payload) => {
        pending = payload as McpConfirmRequest;
        notify();
    });
}

export function getMcpConfirmPending(): McpConfirmRequest | null {
    return pending;
}

export function subscribeMcpConfirm(listener: (req: McpConfirmRequest | null) => void): () => void {
    listeners.add(listener);
    listener(pending);
    return () => listeners.delete(listener);
}

export function respondMcpConfirm(
    req: McpConfirmRequest,
    approved: boolean,
    options: { trustTool?: boolean; trustServer?: boolean },
): void {
    sendToPlugin('mcp.confirm.response', {
        confirmId: req.confirmId,
        approved,
        trustTool: options.trustTool ?? false,
        trustServer: options.trustServer ?? false,
        serverId: req.serverId,
        toolName: req.toolName,
    }).catch(() => undefined);
    pending = null;
    notify();
}

export function useMcpConfirmRequest(): McpConfirmRequest | null {
    const [req, setReq] = useState<McpConfirmRequest | null>(pending);
    useEffect(() => subscribeMcpConfirm(setReq), []);
    return req;
}
