/**
 * Session-scoped MCP tool activity (legacy tool_call + v2 envelope tool.call).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';
import type { EventEnvelope } from './events';
import { parseMcpTool } from '../components/tools/v2/mcpUtils';

export interface McpActivityHit {
    serverId: string;
    toolName: string;
}

const MAX_RECENT = 6;
let recent: McpActivityHit[] = [];
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((l) => l());
}

function record(serverId: string, toolName: string) {
    const key = `${serverId}:${toolName}`;
    recent = [{ serverId, toolName }, ...recent.filter((r) => `${r.serverId}:${r.toolName}` !== key)].slice(
        0,
        MAX_RECENT,
    );
    notify();
}

function recordFromToolName(tool: string) {
    const parsed = parseMcpTool(tool);
    if (parsed) record(parsed.serverId, parsed.toolName);
}

export function clearMcpActivity() {
    recent = [];
    notify();
}

export function getRecentMcpActivity(): McpActivityHit[] {
    return recent;
}

export function installMcpActivityBridge(): () => void {
    const offLegacy = onPluginEvent('tool_call', (payload) => {
        const tc = payload as { name?: string; tool?: string };
        recordFromToolName(tc.name ?? tc.tool ?? '');
    });
    const offEnvelope = onPluginEvent('envelope', (payload) => {
        const ev = payload as EventEnvelope;
        if (ev?.type !== 'tool.call') return;
        const tool = (ev.payload as { tool?: string })?.tool;
        if (tool) recordFromToolName(tool);
    });
    return () => {
        offLegacy();
        offEnvelope();
    };
}

export function useRecentMcpActivity(): McpActivityHit[] {
    const [hits, setHits] = useState(recent);
    useEffect(() => {
        const sub = () => setHits([...recent]);
        listeners.add(sub);
        return () => {
            listeners.delete(sub);
        };
    }, []);
    return hits;
}
