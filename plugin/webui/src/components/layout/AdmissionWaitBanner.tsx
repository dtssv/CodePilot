/**
 * Banner shown when the server admission queue is full and the agent run is waiting.
 * Shows retry progress and, after max retries, a confirmation button to keep retrying.
 */

import { sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';
import { useAdmissionWaitState } from '../../state/admissionWaitStore';

export function AdmissionWaitBanner() {
    const { t } = useTranslation();
    const state = useAdmissionWaitState();

    if (!state) return null;

    const handleRetryConfirm = () => {
        sendToPlugin('admission_retry_resume', {});
    };

    const handleCancel = () => {
        sendToPlugin('stop', {});
    };

    return (
        <div className="admission-wait-banner">
            <div className="admission-wait-banner__icon">⏳</div>
            <div className="admission-wait-banner__content">
                <div className="admission-wait-banner__message">{state.message}</div>
                {!state.askRetry && state.attempt > 0 && (
                    <div className="admission-wait-banner__progress">
                        {t('chat.admissionRetryProgress', { attempt: state.attempt, maxAttempts: state.maxAttempts })}
                    </div>
                )}
            </div>
            {state.askRetry && (
                <div className="admission-wait-banner__actions">
                    <button className="admission-wait-banner__btn admission-wait-banner__btn--retry" onClick={handleRetryConfirm}>
                        {t('chat.admissionRetryContinue')}
                    </button>
                    <button className="admission-wait-banner__btn admission-wait-banner__btn--cancel" onClick={handleCancel}>
                        {t('chat.admissionRetryCancel')}
                    </button>
                </div>
            )}
        </div>
    );
}