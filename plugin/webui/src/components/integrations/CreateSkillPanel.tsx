import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';

export function CreateSkillPanel() {
    const { t } = useTranslation();
    const [id, setId] = useState('skill.user.my-skill');
    const [version, setVersion] = useState('0.1.0');
    const [title, setTitle] = useState('My local skill');
    const [scope, setScope] = useState<'project' | 'global'>('project');
    const [language, setLanguage] = useState('');
    const [action, setAction] = useState('');
    const [prompt, setPrompt] = useState(
        'Your instructions to the model go here. Keep under ~500 tokens.',
    );
    const [saving, setSaving] = useState(false);
    const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    useEffect(() => {
        if (!flash) return;
        const timer = window.setTimeout(() => setFlash(null), 6000);
        return () => window.clearTimeout(timer);
    }, [flash]);

    useEffect(() => {
        return onPluginEvent('skill_create_result', (raw) => {
            const p = raw as { ok?: boolean; message?: string };
            setSaving(false);
            if (p.ok) {
                setFlash({ kind: 'ok', text: t('integrations.createSkill.created') });
            } else {
                setFlash({
                    kind: 'err',
                    text: p.message?.trim() || t('integrations.createSkill.failed'),
                });
            }
        });
    }, [t]);

    const submit = () => {
        setSaving(true);
        sendToPlugin('skill.create_local', {
            id: id.trim(),
            version: version.trim(),
            title: title.trim(),
            scope,
            language: language.trim(),
            action: action.trim(),
            prompt,
        }).catch(() => setSaving(false));
    };

    const openWizard = () => {
        sendToPlugin('skill.open_wizard', {}).catch(() => undefined);
    };

    return (
        <section className="panel-base create-skill-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('integrations.createSkill.title')}</h3>
                    <span className="panel-subtitle">{t('integrations.createSkill.subtitle')}</span>
                </div>
                <button type="button" className="panel-btn" onClick={openWizard}>
                    {t('integrations.createSkill.wizard')}
                </button>
            </header>

            {flash && (
                <div className={`create-skill-flash ${flash.kind === 'err' ? 'create-skill-flash-error' : ''}`}>{flash.text}</div>
            )}

            <div className="panel-section create-skill-grid">
                <label className="create-skill-field">
                    <span>{t('integrations.createSkill.id')}</span>
                    <input className="panel-input" value={id} onChange={(e) => setId(e.target.value)} />
                </label>
                <label className="create-skill-field">
                    <span>{t('integrations.createSkill.version')}</span>
                    <input className="panel-input" value={version} onChange={(e) => setVersion(e.target.value)} />
                </label>
                <label className="create-skill-field create-skill-span2">
                    <span>{t('integrations.createSkill.titleLabel')}</span>
                    <input className="panel-input" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="create-skill-field">
                    <span>{t('integrations.createSkill.scope')}</span>
                    <select className="panel-input" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')}>
                        <option value="project">{t('integrations.createSkill.scopeProject')}</option>
                        <option value="global">{t('integrations.createSkill.scopeGlobal')}</option>
                    </select>
                </label>
                <label className="create-skill-field">
                    <span>{t('integrations.createSkill.language')}</span>
                    <input className="panel-input" value={language} onChange={(e) => setLanguage(e.target.value)} />
                </label>
                <label className="create-skill-field">
                    <span>{t('integrations.createSkill.action')}</span>
                    <input className="panel-input" value={action} onChange={(e) => setAction(e.target.value)} />
                </label>
                <label className="create-skill-field create-skill-span2">
                    <span>{t('integrations.createSkill.prompt')}</span>
                    <textarea className="panel-input create-skill-textarea" rows={12} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                </label>
            </div>

            <div className="panel-actions">
                <button type="button" className="panel-btn panel-btn-primary" disabled={saving} onClick={submit}>
                    {saving ? t('integrations.createSkill.creating') : t('integrations.createSkill.create')}
                </button>
            </div>
        </section>
    );
}
