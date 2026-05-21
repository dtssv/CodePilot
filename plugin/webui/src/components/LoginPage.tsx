import { useEffect, useState } from 'react';
import { sendToPlugin, onPluginEvent } from '../bridge';
import { t, useTranslation } from '../i18n';
import { LanguageSelector } from './layout/LanguageSelector';

interface LoginMethods {
    oidc: boolean;
    hmacBridge: boolean;
    dev: boolean;
    deviceFlow: boolean;
    devUi?: boolean;
}

interface LoginPageProps {
    checkingSession?: boolean;
}

export function LoginPage({ checkingSession = false }: LoginPageProps) {
    useTranslation();
    const [status, setStatus] = useState(
        checkingSession ? t('login.checkingSession') : t('login.loadingOptions'),
    );
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [devToken, setDevToken] = useState('');
    const [devUser, setDevUser] = useState('');
    const [devTenant, setDevTenant] = useState('');
    const [showDevForm, setShowDevForm] = useState(false);
    const [oidcBusy, setOidcBusy] = useState(false);

    const browserLoginAvailable =
        methods == null || ((methods.oidc || methods.deviceFlow) && !methods.hmacBridge);
    const devLoginAvailable = methods?.dev === true && methods?.devUi !== false;

    useEffect(() => {
        sendToPlugin('check_auth', {}).catch(() => undefined);
        sendToPlugin('auth_discover', {}).catch(() => undefined);

        const offMethods = onPluginEvent('auth_methods', (payload) => {
            const m = payload as LoginMethods;
            setMethods(m);
            if ((m.oidc || m.deviceFlow) && !m.hmacBridge) {
                setStatus(t('login.browserHint'));
            } else if (m.dev && m.devUi !== false) {
                setStatus(t('login.devAvailable'));
            } else {
                setStatus(t('login.noMethods'));
            }
        });

        const offLogin = onPluginEvent('auth_login_result', (payload) => {
            const result = payload as { success: boolean; error?: string };
            setOidcBusy(false);
            if (result.success) {
                setStatus(t('login.signedIn'));
            } else {
                setStatus(t('login.signInFailed', { error: result.error || 'unknown' }));
            }
        });

        return () => {
            offMethods();
            offLogin();
        };
    }, []);

    const handleOidcStart = () => {
        setOidcBusy(true);
        setStatus(t('login.openingBrowser'));
        sendToPlugin('auth_login_oidc', {}).catch(() => {
            setOidcBusy(false);
            setStatus(t('login.browserFailed'));
        });
    };

    const handleDevLogin = () => {
        if (!devToken.trim() || !devUser.trim() || !devTenant.trim()) {
            setStatus(t('login.devRequired'));
            return;
        }
        setStatus(t('login.signingInDev'));
        sendToPlugin('auth_login_dev', {
            token: devToken.trim(),
            userId: devUser.trim(),
            tenantId: devTenant.trim(),
        }).catch(() => setStatus(t('login.devSignInRequestFailed')));
    };

    if (checkingSession) {
        return (
            <div className="login-page">
                <div className="login-card">
                    <div className="login-lang-row">
                        <LanguageSelector />
                    </div>
                    <div className="login-icon">✦</div>
                    <h1 className="login-title">{t('chat.emptyTitle')}</h1>
                    <p className="login-status">{status}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-lang-row">
                    <LanguageSelector />
                </div>
                <div className="login-icon">✦</div>
                <h1 className="login-title">{t('login.signInTitle')}</h1>
                <p className="login-subtitle">{t('login.subtitle')}</p>

                <div className="login-form">
                    {browserLoginAvailable && (
                        <>
                            <p className="login-hint">{t('login.browserFlowHint')}</p>
                            <button
                                type="button"
                                className="login-btn"
                                onClick={handleOidcStart}
                                disabled={oidcBusy || methods === null}
                            >
                                {oidcBusy ? t('login.waitingBrowser') : t('login.signInBrowser')}
                            </button>
                        </>
                    )}

                    {devLoginAvailable && (
                        <div className="login-dev-section">
                            {!showDevForm ? (
                                <button
                                    type="button"
                                    className="login-btn login-btn-secondary"
                                    onClick={() => setShowDevForm(true)}
                                >
                                    {t('login.signInDev')}
                                </button>
                            ) : (
                                <>
                                    <p className="login-hint">{t('login.devSectionHint')}</p>
                                    <input
                                        type="password"
                                        className="login-input"
                                        placeholder={t('login.devTokenPlaceholder')}
                                        value={devToken}
                                        onChange={(e) => setDevToken(e.target.value)}
                                    />
                                    <input
                                        type="text"
                                        className="login-input"
                                        placeholder={t('login.devUser')}
                                        value={devUser}
                                        onChange={(e) => setDevUser(e.target.value)}
                                    />
                                    <input
                                        type="text"
                                        className="login-input"
                                        placeholder={t('login.devTenant')}
                                        value={devTenant}
                                        onChange={(e) => setDevTenant(e.target.value)}
                                    />
                                    <button type="button" className="login-btn" onClick={handleDevLogin}>
                                        {t('login.signInDev')}
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                </div>

                <p className="login-status">{status}</p>
            </div>
        </div>
    );
}
