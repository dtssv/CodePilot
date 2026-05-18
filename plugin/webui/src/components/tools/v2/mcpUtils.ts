/** Parse `mcp.<serverId>.<toolName>` tool identifiers. */

export interface McpToolIdentity {
    serverId: string;
    toolName: string;
    fullName: string;
}

export function parseMcpTool(tool: string): McpToolIdentity | null {
    if (!tool.startsWith('mcp.')) return null;
    const rest = tool.slice(4);
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    const serverId = rest.slice(0, dot);
    const toolName = rest.slice(dot + 1);
    if (!serverId || !toolName) return null;
    return { serverId, toolName, fullName: tool };
}

export function isExternalMcpTool(tool: string): boolean {
    return tool.startsWith('mcp.');
}
