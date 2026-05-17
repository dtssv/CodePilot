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
        <div className="templates-panel">
            <div className="panel-header">
                <h3>Prompt Templates</h3>
                <button type="button" onClick={() => setEditing({ id: '', title: '', body: '', variables: [] })}>New</button>
            </div>
            {templates.map((tpl) => (
                <div key={tpl.id} className="template-row">
                    <strong>{tpl.title}</strong>
                    <span className="muted">{tpl.body.slice(0, 100)}</span>
                    <button type="button" onClick={() => useTemplate(tpl)}>Insert</button>
                    <button type="button" onClick={() => setEditing(tpl)}>Edit</button>
                    <button type="button" onClick={() => sendToPlugin('templates.delete', { id: tpl.id })}>Delete</button>
                </div>
            ))}
            {templates.length === 0 && <div className="muted">No templates yet. Create one or add `.codepilot/templates.json`.</div>}
            {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function TemplateEditor({ template, onClose }: { template: Template; onClose: () => void }) {
    const [title, setTitle] = useState(template.title);
    const [body, setBody] = useState(template.body);
    return (
        <div className="template-editor">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Prompt body with {{args}} or {{name}}" />
            <button type="button" onClick={() => {
                sendToPlugin('templates.save', { id: template.id, title, body });
                onClose();
            }}>Save</button>
            <button type="button" onClick={onClose}>Cancel</button>
        </div>
    );
}

function useTemplate(tpl: Template) {
    let body = tpl.body;
    const variables = Array.from(body.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]).filter((v) => v !== 'args' && v !== 'workspace');
    for (const name of variables) body = body.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), prompt(`${name}?`, '') ?? '');
    document.dispatchEvent(new CustomEvent('codepilot:input.set', { detail: body }));
}
