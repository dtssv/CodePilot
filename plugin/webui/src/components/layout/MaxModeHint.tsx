import type { ModelRouteInfo } from '../../state/modelAuthBridge';

interface MaxModeHintProps {
    maxMode: boolean;
    lastRoute?: ModelRouteInfo | null;
}

function thinkingLabel(transport?: string, mode?: string): string {
    if (transport === 'anthropic-extra') return `Claude thinking${mode ? ` (${mode})` : ''}`;
    if (transport === 'openai-reasoning') return `reasoning${mode ? ` ${mode}` : ''}`;
    return mode ? `thinking ${mode}` : 'high thinking';
}

export function MaxModeHint({ maxMode, lastRoute }: MaxModeHintProps) {
    if (!maxMode) return null;
    return (
        <div className="max-mode-hint" role="status">
            <span className="max-mode-hint-badge">Max</span>
            <span className="max-mode-hint-text">
                Premium model
                {' · '}
                {thinkingLabel(lastRoute?.thinkingTransport, lastRoute?.thinkingMode)}
                {' · up to 8k output'}
                {lastRoute?.name ? ` · ${lastRoute.name}` : ''}
                {lastRoute?.tier ? ` (${lastRoute.tier})` : ''}
            </span>
        </div>
    );
}
