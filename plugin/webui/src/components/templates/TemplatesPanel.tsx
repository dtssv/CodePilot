import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';

interface Template {
    id: string;
    title: string;
    body: string;
    variables?: string[];
}

export function TemplatesPanel() {
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
                    <h3 className="panel-title">📋 Prompt Templates</h3>
                    <span className="panel-subtitle">Reusable prompt patterns</span>
                </div>
                <button type="button" className="panel-btn panel-btn-primary" onClick={() => setEditing({ id: '', title: '', body: '', variables: [] })}>New</button>
            </div>
            {templates.map((tpl) => (
                <div key={tpl.id} className="panel-card">
                    <div className="panel-card-header">
                        <strong>{tpl.title}</strong>
                        <span className="panel-card-meta">{tpl.body.slice(0, 100)}</span>
                    </div>
                    <div className="panel-actions">
                        <button type="button" className="panel-btn panel-btn-primary" onClick={() => useTemplate(tpl)}>Insert</button>
                        <button type="button" className="panel-btn" onClick={() => setEditing(tpl)}>Edit</button>
                        <button type="button" className="panel-btn panel-btn-danger" onClick={() => sendToPlugin('templates.delete', { id: tpl.id })}>Delete</button>
                    </div>
                </div>
            ))}
            {templates.length === 0 && <div className="panel-empty">No templates yet. Create one or add `.codepilot/templates.json`.</div>}
            {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function TemplateEditor({ template, onClose }: { template: Template; onClose: () => void }) {
    const [title, setTitle] = useState(template.title);
    const [body, setBody] = useState(template.body);
    return (
        <div className="template-editor panel-card">
            <div className="panel-card-header">
                <strong>Edit Template</strong>
            </div>
            <div className="panel-form-group">
                <label className="panel-label">Title</label>
                <input className="panel-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            </div>
            <div className="panel-form-group">
                <label className="panel-label">Body</label>
                <textarea className="panel-textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Prompt body with {{args}} or {{name}}" rows={6} />
            </div>
            <div className="panel-actions">
                <button type="button" className="panel-btn panel-btn-primary" onClick={() => {
                    sendToPlugin('templates.save', { id: template.id, title, body });
                    onClose();
                }}>Save</button>
                <button type="button" className="panel-btn" onClick={onClose}>Cancel</button>
            </div>
        </div>
    );
}

function useTemplate(tpl: Template) {
    let body = tpl.body;
    const variables = Array.from(body.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]).filter((v) => v !== 'args' && v !== 'workspace');
    for (const name of variables) body = body.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), prompt(`${name}?`, '') ?? '');
    document.dispatchEvent(new CustomEvent('codepilot:input.set', { detail: body }));
}
