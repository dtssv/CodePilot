/**
 * In-chat MCP activity strip: pending approval + recent MCP tool calls (v1 + v2).
 */

import { useTranslation } from '../../i18n';
import { useMcpConfirmRequest } from '../../state/mcpConfirm';
import { useRecentMcpActivity } from '../../state/mcpActivityStore';

export function McpActivityBanner() {
    const { t } = useTranslation();
    const confirmReq = useMcpConfirmRequest();
    const recentMcp = useRecentMcpActivity();

    if (!confirmReq && recentMcp.length === 0) return null;

    return (
        <div className="mcp-activity-banner" role="status">
            {confirmReq && (
                <div className="mcp-activity-pending">
                    <span className="mcp-activity-icon">🔌</span>
                    <span>
                        {t('mcp.pending')} <strong>{confirmReq.serverId}</strong> /{' '}
                        <code>{confirmReq.toolName}</code>
                    </span>
                </div>
            )}
            {recentMcp.length > 0 && (
                <div className="mcp-activity-recent">
                    {recentMcp.slice(0, 4).map((m) => (
                        <span
                            key={`${m.serverId}:${m.toolName}`}
                            className="mcp-activity-chip"
                            title={t('mcp.tool')}
                        >
                            {m.serverId} · {m.toolName}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
