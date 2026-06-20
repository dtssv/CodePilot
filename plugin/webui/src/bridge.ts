/**
 * CefMessageRouter bridge for bidirectional communication between
 * the JCEF Web UI and the IntelliJ plugin host.
 *
 * Plugin → Web: window.__codepilot_dispatch(eventType, payload)
 * Web → Plugin: window.cefQuery({ request: JSON.stringify(msg), ... })
 */

export interface BridgeMessage {
    type: string;
    payload: unknown;
}

/** Events dispatched from plugin (Kotlin) to web. */
export type PluginEventType =
    | 'delta'
    | 'tool_call'
    | 'tool_result_ack'
    | 'plan'
    | 'plan_delta'
    | 'task_ledger'
    | 'digest'
    | 'needs_input'
    | 'risk_notice'
    | 'self_check'
    | 'done'
    | 'conversation_running'
    | 'server_backoff'
    | 'admission_queued'
    | 'admission_retry_ask'
    | 'admission_granted'
    | 'message_queued'
    | 'message_queue_updated'
    | 'chat_reset'
    | 'error'
    | 'rate_limited'
    | 'skills_activated'
    | 'models_loaded'
    | 'user_message_saved'
    | 'session_list'
    | 'session_switched'
    | 'session_messages'
    | 'session.search.result'
    | 'branch.tree.result'
    | 'voice_result'
    | 'voice.result'
    | 'model.routed'
    | 'usage.update'
    | 'slash.commands.loaded'
    | 'templates.loaded'
    | 'bg.tasks.update'
    | 'bg.log'
    | 'bg.error'
    | 'bg.action.result'
    | 'export.preview.result'
    | 'export.save.result'
    | 'share.create.result'
    | 'share.get.result'
    | 'share.status.result'
    | 'action_start'
    | 'action_done'
    | 'context_added'
    | 'ui.focus_chat'
    | 'patch'
    | 'auth_state'
    | 'auth_methods'
    | 'auth_login_result'
    | 'at_suggestions'
    | 'at_resolved'
    | 'user_plan'
    | 'user_plan_progress'
    | 'multi_file_patches'
    | 'patches_applied'
    | 'notepad_list_result'
    | 'context_budget'
    | 'skill_list_result'
    | 'skill_create_result'
    | 'marketplace.error'
    | 'composer_result'
    | 'ide_theme'
    | 'app_locale'
    | 'branch_list'
    | 'session_cost'
    | 'session_interrupted'
    | 'session_resuming'
    | 'auto_apply_state'
    | 'pending_changes'
    | 'console_log'
    | 'agent_thinking'
    | 'agent_reading'
    | 'agent_writing'
    | 'agent_running'
    | 'graph_verify'
    | 'graph_phase_done'
    | 'graph_repair_plan'
    | 'graph_budget_alert'
    | 'shell.progress'
    // v2 protocol — see doc/01-event-protocol.md and src/state/.
    | 'envelope'
    // P0-03 hunk apply
    | 'apply.list_response'
    | 'apply.result'
    // P0-04 inline edit + tab stats
    | 'tab.stats_response'
    // P1-05 codebase index/search
    | 'codebase.status_response'
    | 'codebase.search_response'
    // P1-06 rules/memories
    | 'rules.response'
    | 'memory.response'
    // P1-07 MCP/hooks
    | 'mcp.response'
    | 'mcp.confirm.request'
    | 'mcp.install_result'
    | 'hooks.response'
    // P1-08 shell policy
    | 'shell.policy_response'
    // delta diff — file change summaries
    | 'delta_diff';

type EventHandler = (payload: unknown) => void;
const listeners = new Map<string, Set<EventHandler>>();

/** Register a listener for events from the plugin. */
export function onPluginEvent(type: PluginEventType, handler: EventHandler): () => void {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
    return () => listeners.get(type)?.delete(handler);
}

/** Called by the plugin via JS injection: window.__codepilot_dispatch */
function dispatch(type: string, payload: unknown) {
    const handlers = listeners.get(type);
    if (handlers) handlers.forEach((h) => h(payload));
}

// Expose to global for the plugin to call
(window as unknown as Record<string, unknown>).__codepilot_dispatch = dispatch;

/** Send a message from web to the plugin via CefMessageRouter. */
export function sendToPlugin(type: string, payload: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
        const msg = JSON.stringify({ type, payload });
        const cef = (window as unknown as Record<string, unknown>).cefQuery as
            | ((args: {
                request: string;
                onSuccess: (r: string) => void;
                onFailure: (code: number, msg: string) => void;
            }) => void)
            | undefined;
        if (cef) {
            cef({
                request: msg,
                onSuccess: resolve,
                onFailure: (_code, errMsg) => reject(new Error(errMsg)),
            });
        } else {
            // Fallback for dev mode (no CEF)
            console.log('[bridge:toPlugin]', type, payload);
            resolve('ok');
        }
    });
}