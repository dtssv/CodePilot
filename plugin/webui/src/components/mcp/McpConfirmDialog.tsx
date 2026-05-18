import { respondMcpConfirm, useMcpConfirmRequest } from '../../state/mcpConfirm';

export function McpConfirmDialog() {
    const req = useMcpConfirmRequest();
    if (!req) return null;

    const deny = () => respondMcpConfirm(req, false, {});
    const allowOnce = () => respondMcpConfirm(req, true, {});
    const trustTool = () => respondMcpConfirm(req, true, { trustTool: true });
    const trustServer = () => respondMcpConfirm(req, true, { trustServer: true });

    return (
        <div className="mcp-confirm-overlay" role="dialog" aria-modal aria-labelledby="mcp-confirm-title">
            <div className="mcp-confirm-dialog">
                <h3 id="mcp-confirm-title">Allow MCP tool?</h3>
                <p className="mcp-confirm-meta">
                    <span className="tool-mcp-badge">MCP</span>
                    <code>{req.serverId}</code>
                    <span>·</span>
                    <code>{req.toolName}</code>
                </p>
                <p className="muted mcp-confirm-full">{req.fullName}</p>
                {req.argsPreview && (
                    <pre className="mcp-confirm-args">{req.argsPreview}</pre>
                )}
                <p className="mcp-confirm-hint">
                    External MCP tools can read or modify resources exposed by the server. Review arguments before approving.
                </p>
                <div className="mcp-confirm-actions">
                    <button type="button" className="panel-btn" onClick={deny}>Deny</button>
                    <button type="button" className="panel-btn panel-btn-primary" onClick={allowOnce}>Allow once</button>
                    <button type="button" className="panel-btn" onClick={trustTool}>Always allow tool</button>
                    <button type="button" className="panel-btn" onClick={trustServer}>Trust server</button>
                </div>
            </div>
        </div>
    );
}
