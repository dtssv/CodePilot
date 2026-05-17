import { sendToPlugin } from '../../bridge';

export interface SlashCommand {
    name: string;
    aliases?: string[];
    description: string;
    run: (args: string[], ctx: SlashCtx) => Promise<void> | void;
}

export interface SlashCtx {
    setInput: (text: string) => void;
    setModel?: (id: string) => void;
    sessionCost?: { estimatedCostUsd: number; messageCount: number };
}

export interface CustomSlashSpec {
    name: string;
    description: string;
    prompt: string;
}

export function builtinCommands(): SlashCommand[] {
    return [
        { name: 'clear', description: 'Create a new empty chat', run: () => sendToPlugin('new_session', {}) },
        {
            name: 'cost',
            description: 'Show current session cost',
            run: (_args, ctx) => alert(`Session cost: $${(ctx.sessionCost?.estimatedCostUsd ?? 0).toFixed(4)} (${ctx.sessionCost?.messageCount ?? 0} msgs)`),
        },
        { name: 'model', aliases: ['m'], description: 'Switch model: /model auto or /model <id>', run: (args, ctx) => ctx.setModel?.(args[0] || 'auto') },
        { name: 'compress', description: 'Compress conversation history', run: () => sendToPlugin('compress_context', {}) },
        { name: 'branch', description: 'Fork from the latest message', run: () => sendToPlugin('fork_from_message', { messageIndex: -1 }) },
        { name: 'run', description: 'Ask CodePilot to run a shell command', run: (args, ctx) => ctx.setInput(`Run this shell command and summarize the result:\n\n${args.join(' ')}`) },
        { name: 'help', description: 'List slash commands', run: (_args, ctx) => ctx.setInput(builtinCommands().map((c) => `/${c.name} - ${c.description}`).join('\n')) },
    ];
}

export function customCommands(specs: CustomSlashSpec[]): SlashCommand[] {
    return specs.map((spec) => ({
        name: spec.name,
        description: spec.description || 'Custom prompt template',
        run: (args, ctx) => ctx.setInput(resolveTemplate(spec.prompt, args)),
    }));
}

function resolveTemplate(body: string, args: string[]): string {
    return body
        .replace(/\{\{args\}\}/g, args.join(' '))
        .replace(/\{\{workspace\}\}/g, '')
        .replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => prompt(`${name}?`, '') ?? '');
}
