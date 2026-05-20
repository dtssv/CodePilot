import { secondsUntilUnblock, useRateLimitState } from '../../state/rateLimitStore';

export function RateLimitBanner() {
    const state = useRateLimitState();
    if (!state) return null;

    const remaining = secondsUntilUnblock();
    const opHint = state.opType ? `（${state.opType}）` : '';

    return (
        <div className="rate-limit-banner" role="alert" aria-live="polite">
            <div className="rate-limit-title">请求过于频繁{opHint}</div>
            <p className="rate-limit-message">{state.message}</p>
            <p className="rate-limit-countdown muted">
                {remaining > 0
                    ? `请等待约 ${remaining} 秒后再试（限流窗口 ${state.retryAfterSec} 秒）`
                    : '可以重新发送'}
            </p>
        </div>
    );
}
