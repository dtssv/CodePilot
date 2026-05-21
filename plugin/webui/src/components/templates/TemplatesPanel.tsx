import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { t, useTranslation } from '../../i18n';

interface Template {
    id: string;
    title: string;
    body: string;
    variables?: string[];
}

export function TemplatesPanel() {
    const { t: tr } = useTranslation();
    const [templates, setTemplates] = useState<Template[]>([]);
    const [editing, setEditing] = useState<Template | null>(null);
    useEffect(() => {
        const off = onPluginEvent('templates.loaded', (payload) => setTemplates(((payload as { templates?: Template[] }).templates ?? [])));
        sendToPlugin('templates.list', {}).catch(() => undefined);
        return off;
    }, []);
    return (
        <div className="panel-base templates-panel">
            <div className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{tr('panels.templates.title')}</h3>
                    <span className="panel-subtitle">{tr('panels.templates.subtitle')}</span>
                </div>
                <button type="button" className="panel-btn panel-btn-primary" onClick={() => setEditing({ id: '', title: '', body: '', variables: [] })}>
                    {tr('panels.new')}
                </button>
            </div>
            {templates.map((tpl) => (
                <div key={tpl.id} className="panel-card">
                    <div className="panel-card-header">
                        <strong>{tpl.title}</strong>
                        <span className="panel-card-meta">{tpl.body.slice(0, 100)}</span>
                    </div>
                    <div className="panel-actions">
                        <button type="button" className="panel-btn panel-btn-primary" onClick={() => useTemplate(tpl)}>
                            {tr('panels.templates.insert')}
                        </button>
                        <button type="button" className="panel-btn" onClick={() => setEditing(tpl)}>
                            {tr('common.edit')}
                        </button>
                        <button type="button" className="panel-btn panel-btn-danger" onClick={() => sendToPlugin('templates.delete', { id: tpl.id })}>
                            {tr('common.delete')}
                        </button>
                    </div>
                </div>
            ))}
            {templates.length === 0 && <div className="panel-empty">{tr('panels.templates.empty')}</div>}
            {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function TemplateEditor({ template, onClose }: { template: Template; onClose: () => void }) {
    const { t: tr } = useTranslation();
    const [title, setTitle] = useState(template.title);
    const [body, setBody] = useState(template.body);
    return (
        <div className="template-editor panel-card">
            <div className="panel-card-header">
                <strong>{tr('panels.templates.edit')}</strong>
            </div>
            <div className="panel-form-group">
                <label className="panel-label">{tr('panels.templates.fieldTitle')}</label>
                <input className="panel-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('panels.templates.placeholderTitle')} />
            </div>
            <div className="panel-form-group">
                <label className="panel-label">{tr('panels.templates.fieldBody')}</label>
                <textarea
                    className="panel-textarea"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={tr('panels.templates.placeholderBody')}
                    rows={6}
                />
            </div>
            <div className="panel-actions">
                <button
                    type="button"
                    className="panel-btn panel-btn-primary"
                    onClick={() => {
                        sendToPlugin('templates.save', { id: template.id, title, body });
                        onClose();
                    }}
                >
                    {tr('panels.save')}
                </button>
                <button type="button" className="panel-btn" onClick={onClose}>
                    {tr('common.cancel')}
                </button>
            </div>
        </div>
    );
}

function useTemplate(tpl: Template) {
    let body = tpl.body;
    const variables = Array.from(body.matchAll(/\{\{(\w+)\}\}/g))
        .map((m) => m[1])
        .filter((v) => v !== 'args' && v !== 'workspace');
    for (const name of variables) body = body.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), prompt(t('panels.templates.varPrompt', { name }), '') ?? '');
    document.dispatchEvent(new CustomEvent('codepilot:input.set', { detail: body }));
}
