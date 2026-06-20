import { useState } from 'react';
import { AGENT_ROLES, type AgentRole } from './AgentRole';
import './AgentRoleSelector.css';

interface AgentRoleSelectorProps {
    value: AgentRole;
    onChange: (role: AgentRole) => void;
}

export function AgentRoleSelector({ value: currentRole, onChange }: AgentRoleSelectorProps) {
    const [open, setOpen] = useState(false);

    const current = AGENT_ROLES.find((r) => r.id === currentRole) ?? AGENT_ROLES[0];

    const handleSelect = (role: AgentRole) => {
        onChange(role);
        setOpen(false);
    };

    return (
        <div className="agent-role-selector">
            <button className="agent-role-button" onClick={() => setOpen(!open)}>
                <span className="agent-role-dot" />
                <span className="agent-role-label">{current.labelKey}</span>
                <svg className="agent-role-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>
            {open && (
                <div className="agent-role-dropdown">
                    {AGENT_ROLES.map((role, i) => (
                        <button
                            key={role.id}
                            className={`agent-role-option ${(i === 0 ? 'ag-opt-first' : '')} ${role.id === currentRole ? 'ag-opt-active' : ''}`}
                            onClick={() => handleSelect(role.id)}
                        >
                            <span className="ag-opt-dot" />
                            <span className="ag-opt-label">{role.labelKey}</span>
                            <span className="ag-opt-desc">{role.descKey}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}