// MCP prompts as dynamic slash commands (no on-disk markdown). Listed beside
// project/user commands; expanded via McpManager.getPrompt at resolve time.

import type { McpManager } from "./mcp.js";
import type { McpPromptDescriptor } from "./mcp-types.js";
import {
  mcpPromptCommandName,
  mcpPromptCommandNamePrefixed,
} from "./mcp-names.js";
import type { SlashCommand } from "../skills/slashCommands.js";
import { sanitizeUntrustedMcpText } from "./mcpResultSanitize.js";

/** Turn an MCP prompt descriptor into a synthetic slash command. */
export function mcpPromptToSlashCommand(
  p: McpPromptDescriptor,
  opts?: { prefixed?: boolean },
): SlashCommand {
  const required = (p.arguments ?? []).filter((a) => a.required).map((a) => a.name);
  const optional = (p.arguments ?? []).filter((a) => !a.required).map((a) => a.name);
  // Only required args force a usage hint (empty invoke blocked). Optional
  // args stay in the description so `/cmd` without args still expands.
  const hintParts = [
    ...required.map((n) => `<${n}>`),
    ...optional.map((n) => `[${n}]`),
  ];
  const name = opts?.prefixed
    ? mcpPromptCommandNamePrefixed(p.server, p.name)
    : mcpPromptCommandName(p.server, p.name);
  const descBase = p.description?.trim() || `MCP prompt "${p.name}" (${p.server})`;
  const desc =
    optional.length > 0 && required.length === 0
      ? `${descBase} (optional: ${optional.join(", ")})`
      : descBase;
  return {
    name,
    description: desc,
    ...(required.length > 0 ? { argumentHint: hintParts.join(" ") } : {}),
    path: "",
    source: "mcp",
    body: "",
    mcpPrompt: { server: p.server, name: p.name },
  };
}

export interface ListMcpPromptSlashOptions {
  /** Names already claimed by markdown/builtin commands — MCP side gets a
   * prefixed name and a warning instead of silently shadowing. */
  takenNames?: ReadonlySet<string>;
  onWarn?: (msg: string) => void;
}

/** List synthetic slash commands for every prompt on the manager. */
export function listMcpPromptSlashCommands(
  mcp: McpManager | null | undefined,
  opts?: ListMcpPromptSlashOptions,
): SlashCommand[] {
  if (!mcp) return [];
  const taken = opts?.takenNames;
  const out: SlashCommand[] = [];
  for (const p of mcp.listAllPrompts()) {
    const base = mcpPromptCommandName(p.server, p.name);
    if (taken?.has(base) || taken?.has(base.toLowerCase())) {
      const prefixed = mcpPromptCommandNamePrefixed(p.server, p.name);
      opts?.onWarn?.(
        `MCP prompt "${p.server}/${p.name}" collides with existing command /${base}; registered as /${prefixed}`,
      );
      out.push(mcpPromptToSlashCommand(p, { prefixed: true }));
    } else {
      out.push(mcpPromptToSlashCommand(p));
    }
  }
  return out;
}

/**
 * Expand an MCP slash command by calling `prompts/get`. `argsText` is either
 * free-form (single leftover string as `arguments`) or `key=value` pairs.
 */
export async function expandMcpPromptCommand(
  cmd: SlashCommand,
  argsText: string,
  mcp: McpManager,
): Promise<string> {
  const meta = cmd.mcpPrompt;
  if (!meta) throw new Error(`not an MCP prompt command: /${cmd.name}`);
  const args = parsePromptArgs(argsText);
  const raw = await mcp.getPrompt(meta.server, meta.name, args);
  return formatPromptResult(raw);
}

function parsePromptArgs(argsText: string): Record<string, string> | undefined {
  const trimmed = argsText.trim();
  if (!trimmed) return undefined;
  const out: Record<string, string> = {};
  const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const leftovers: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0) {
      const key = tok.slice(0, eq);
      let val = tok.slice(eq + 1);
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      out[key] = val;
    } else {
      leftovers.push(tok.replace(/^"|"$/g, ""));
    }
  }
  if (leftovers.length > 0 && out.arguments === undefined) {
    out.arguments = leftovers.join(" ");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize prompts/get payload into plain text for the user turn. */
export function formatPromptResult(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return sanitizeUntrustedMcpText(raw);
  if (typeof raw !== "object") return sanitizeUntrustedMcpText(String(raw));
  const obj = raw as {
    description?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const parts: string[] = [];
  if (typeof obj.description === "string" && obj.description.trim()) {
    parts.push(sanitizeUntrustedMcpText(obj.description.trim()));
  }
  for (const m of obj.messages ?? []) {
    const role = typeof m.role === "string" ? m.role : "message";
    const text = contentToText(m.content);
    if (text) parts.push(`[${role}]\n${sanitizeUntrustedMcpText(text)}`);
  }
  if (parts.length === 0) {
    try {
      return sanitizeUntrustedMcpText(JSON.stringify(raw, null, 2));
    } catch {
      return sanitizeUntrustedMcpText(String(raw));
    }
  }
  return parts.join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && "text" in (content as object)) {
      const t = (content as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    }
    return "";
  }
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "text" in c) {
        const t = (c as { text?: unknown }).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Format a resources/read result for model/user consumption. */
export function formatResourceReadResult(raw: {
  contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
}): string {
  const contents = raw.contents ?? [];
  if (contents.length === 0) return "(empty resource)";
  return contents
    .map((c) => {
      const header = [c.uri, c.mimeType].filter(Boolean).join(" · ");
      if (typeof c.text === "string") {
        return `${header ? `[${header}]\n` : ""}${sanitizeUntrustedMcpText(c.text)}`;
      }
      if (typeof c.blob === "string") {
        return `${header ? `[${header}] ` : ""}(base64 blob, ${c.blob.length} chars)`;
      }
      return header ? `[${header}] (empty)` : "(empty)";
    })
    .join("\n\n");
}
