import type { AppTab } from '../../types/appTabs';

export interface AppTabBarProps {
    activeTab: AppTab;
    theme: 'dark' | 'light' | 'high-contrast';
    pendingMemoryCount: number;
    bgActiveCount: number;
    onTabChange: (tab: AppTab) => void;
    onThemeCycle: () => void;
}

export function AppTabBar({
    activeTab,
    theme,
    pendingMemoryCount,
    bgActiveCount,
    onTabChange,
    onThemeCycle,
}: AppTabBarProps) {
    return (
        <div className="tab-bar">
            <div className="tab-row-primary">
                <button className={activeTab === 'chat' ? 'tab-active' : 'tab-btn'} onClick={() => onTabChange('chat')} title="Chat">
                    <span className="tab-icon">💬</span><span className="tab-label">Chat</span>
                </button>
                <button className={activeTab === 'composer' ? 'tab-active' : 'tab-btn'} onClick={() => onTabChange('composer')} title="Composer">
                    <span className="tab-icon">✏️</span><span className="tab-label">Composer</span>
                </button>
            </div>
            <div className="tab-row-secondary">
                <button className={activeTab === 'codebase' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('codebase')} title="Codebase Index">
                    <span className="tab-icon">📦</span>
                </button>
                <button className={activeTab === 'rules' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('rules')} title="Rules & Memories">
                    <span className="tab-icon">📜</span>
                    {pendingMemoryCount > 0 && <span className="tab-badge">{pendingMemoryCount}</span>}
                </button>
                <button className={activeTab === 'notepads' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('notepads')} title="Notepads">
                    <span className="tab-icon">📝</span>
                </button>
                <button className={activeTab === 'templates' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('templates')} title="Prompt Templates">
                    <span className="tab-icon">📋</span>
                </button>
                <span className="tab-sep" />
                <button className={activeTab === 'mcp' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('mcp')} title="MCP Servers & Hooks">
                    <span className="tab-icon">🔌</span>
                </button>
                <button className={activeTab === 'marketplace' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('marketplace')} title="Marketplace">
                    <span className="tab-icon">🏪</span>
                </button>
                <button className={activeTab === 'shell' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('shell')} title="Shell Policy">
                    <span className="tab-icon">⌨️</span>
                </button>
                <span className="tab-sep" />
                <button className={activeTab === 'tab' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('tab')} title="Tab Completion">
                    <span className="tab-icon">↹</span>
                </button>
                <button className={activeTab === 'usage' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('usage')} title="Usage & Cost">
                    <span className="tab-icon">📊</span>
                </button>
                <button className={activeTab === 'background' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('background')} title="Background Agents">
                    <span className="tab-icon">🤖</span>
                    {bgActiveCount > 0 && <span className="tab-badge">{bgActiveCount}</span>}
                </button>
                <button className={activeTab === 'export' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('export')} title="Share & Export">
                    <span className="tab-icon">📤</span>
                </button>
                <button className={activeTab === 'console' ? 'tab-active tab-sm' : 'tab-btn tab-sm'} onClick={() => onTabChange('console')} title="Console">
                    <span className="tab-icon">🖥️</span>
                </button>
            </div>
            <button className="tab-btn tab-theme-btn" onClick={onThemeCycle} title="切换主题">
                {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐'}
            </button>
        </div>
    );
}
