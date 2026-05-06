import { sendToPlugin } from '../bridge';

interface RiskNoticeCardProps {
    level: string;
    message: string;
    filesPaths: string[];
}

export function RiskNoticeCard({ level, message, filesPaths }: RiskNoticeCardProps) {
    const handleApprove = () => sendToPlugin('risk_approved', { approved: true });
    const handleReject = () => sendToPlugin('risk_approved', { approved: false });

    return (
        <div className={`risk-card risk-${level}`}>
            <div className="risk-card-header">
                <span className="risk-level">⚠ {level.toUpperCase()} RISK</span>
            </div>
            <p className="risk-message">{message}</p>
            {filesPaths.length > 0 && (
                <ul className="risk-files">
                    {filesPaths.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
            )}
            <div className="risk-actions">
                <button className="primary" onClick={handleApprove}>Approve</button>
                <button onClick={handleReject}>Reject</button>
            </div>
        </div>
    );
}