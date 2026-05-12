import { useEffect, useState } from 'react';
import { sendToPlugin, onPluginEvent } from '../bridge';

type LoginMethod = 'oidc' | 'bridge' | 'dev';

interface LoginMethods {
    oidc: boolean;
    hmacBridge: boolean;
    dev: boolean;
    deviceFlow: boolean;
}

export function LoginPage() {
    const [tab, setTab] = useState<LoginMethod>('bridge');
    const [status, setStatus] = useState('Loading login options...');
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [bridgeToken, setBridgeToken] = useState('');
    const [devToken, setDevToken] = useState('');
    const [devUser, setDevUser] = useState('');
    const [devTenant, setDevTenant] = useState('');
    const [oidcStatus, setOidcStatus] = useState('');

    useEffect(() => {
        sendToPlugin('auth_discover', {}).catch(() => {});
        const unsub = onPluginEvent('auth_methods', (payload) => {
            const m = payload as LoginMethods;
            setMethods(m);
            if (m.hmacBridge) setTab('bridge');
            else if (m.oidc && m.deviceFlow) setTab('oidc');
            else if (m.dev) setTab('dev');
            setStatus('Pick a login method.');
        });
        return unsub;
    }, []);

    useEffect(() => {
        const unsub = onPluginEvent('auth_login_result', (payload) => {
            const result = payload as { success: boolean; error?: string };
            if (result.success) {
                setStatus('Signed in! Switching to chat...');
            } else {
                setStatus('Login failed: ' + (result.error || 'unknown error'));
            }
        });
        return unsub;
    }, []);

    const handleBridgeLogin = () => {
        if (!bridgeToken.trim()) { setStatus('Token must not be empty.'); return; }
        setStatus('Signing in...');
        sendToPlugin('auth_login_bridge', { token: bridgeToken.trim() }).catch(() => {});
    };

    const handleDevLogin = () => {
        if (!devToken.trim() || !devUser.trim() || !devTenant.trim()) {
            setStatus('All fields are required.');
            return;
        }
        setStatus('Signing in (dev)...');
        sendToPlugin('auth_login_dev', {
            token: devToken.trim(),
            userId: devUser.trim(),
            tenantId: devTenant.trim(),
        }).catch(() => {});
    };

    const handleOidcStart = () => {
        setOidcStatus('Requesting device code...');
        setStatus('Starting OIDC login...');
        sendToPlugin('auth_login_oidc', {}).catch(() => {});
    };

    const tabs: { key: LoginMethod; label: string; available: boolean }[] = [
        { key: 'bridge', label: 'SSO Token', available: methods?.hmacBridge ?? false },
        { key: 'oidc', label: 'OIDC (Browser)', available: (methods?.oidc && methods?.deviceFlow) ?? false },
        { key: 'dev', label: 'Dev Login', available: methods?.dev ?? false },
    ];

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-icon">✦</div>
                <h1 className="login-title">Sign in to CodePilot</h1>
                <p className="login-subtitle">Connect your IDE to the CodePilot backend</p>
                <div className="login-tabs">
                    {tabs.filter(t => t.available || methods === null).map(t => (
                        <button
                            key={t.key}
                            className={'login-tab' + (tab === t.key ? ' active' : '')}
                            onClick={() => setTab(t.key)}
                            disabled={methods !== null && !t.available}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="login-form">
                    {tab === 'bridge' && (
                        <>
                            <p className="login-hint">Paste the bootstrap token issued by your SSO Adapter.</p>
                            <input type="password" className="login-input" placeholder="SSO bridge token"
                                value={bridgeToken} onChange={e => setBridgeToken(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleBridgeLogin()} />
                            <button className="login-btn" onClick={handleBridgeLogin}>Sign in</button>
                        </>
                    )}
                    {tab === 'oidc' && (
                        <>
                            <p className="login-hint">Click Start to open your browser. The IDE will sign in once you finish there.</p>
                            <button className="login-btn" onClick={handleOidcStart}>Start</button>
                            {oidcStatus && <p className="login-oidc-status">{oidcStatus}</p>}
                        </>
                    )}
                    {tab === 'dev' && (
                        <>
                            <p className="login-hint">Dev mode is for local demos only. The backend must enable it.</p>
                            <input type="password" className="login-input" placeholder="Dev shared token"
                                value={devToken} onChange={e => setDevToken(e.target.value)} />
                            <input type="text" className="login-input" placeholder="User ID"
                                value={devUser} onChange={e => setDevUser(e.target.value)} />
                            <input type="text" className="login-input" placeholder="Tenant ID"
                                value={devTenant} onChange={e => setDevTenant(e.target.value)} />
                            <button className="login-btn" onClick={handleDevLogin}>Sign in (dev)</button>
                        </>
                    )}
                </div>
                <p className="login-status">{status}</p>
            </div>
        </div>
    );
}