import { useTranslation } from '../../i18n';
import { useMessageQueue } from '../../state/messageQueueStore';

export function MessageQueueBanner() {
    const { t } = useTranslation();
    const queue = useMessageQueue();
    if (queue.length === 0) return null;

    return (
        <div className="message-queue-banner" role="status" aria-live="polite">
            <div className="message-queue-header">
                <span className="message-queue-title">{t('queue.title', { n: queue.length })}</span>
                <span className="message-queue-hint">{t('queue.hint')}</span>
            </div>
            <ol className="message-queue-list">
                {queue.map((item, idx) => (
                    <li key={`${idx}-${item.text.slice(0, 32)}`} className="message-queue-item">
                        <span className="message-queue-index">{idx + 1}</span>
                        <span className="message-queue-text" title={item.text}>
                            {item.text.length > 120 ? `${item.text.slice(0, 120)}…` : item.text}
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    );
}
