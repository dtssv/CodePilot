// Session MCP support: extracted from the monolithic session.ts.
//
// - startMcp(host): boots configured MCP servers and registers their
// tools into the session's registry (called from Session.init).
// - resolveSessionMcpReferences(mcp, prompt): expands `@mcp:<server>/<uri>`
// references into inline resource content before the agent sees the prompt.
// - jsonSchemaToZod / compileJsonSchema: tiny JSON-Schema → Zod converter
// for the subset of schema features MCP servers actually use.

import { z } from "zod";
import {
  McpManager,
  resolveMcpReferences,
  normalizeMcpToolName,
} from "./mcp.js";
import { acquireSharedMcp } from "./mcp-pool.js";
import type { ToolRegistry } from "./tools/types.js";
import type { CodepilotConfig, SessionOptions } from "./types.js";

/** Minimal structural view of the Session fields startMcp needs. Uses a
 * callback for the (private) tool registry to avoid a public type cycle. */
export interface SessionMcpHost {
  readonly config: CodepilotConfig;
  readonly cwd: string;
  readonly onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
  readonly onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
 /** Called with the session's (private) tool registry. */
  withToolRegistry<T>(fn: (registry: ToolRegistry) => T): T;
 /** Stash the unregister fn for the reverse-request handler so the session
  * can detach it on dispose. Critical for the SHARED (pooled) manager: without
  * unregistering, a disposed session's handler stays registered and a server
  * reverse request would be routed to a dead session. */
  setMcpRequestHandlerCleanup?(unregister: () => void): void;
}

/** Start configured MCP servers (shared process-wide) and register tools.
 * Errors are non-fatal so a broken server can't block the session. */
export async function startMcp(host: SessionMcpHost): Promise<McpManager | null> {
  if (!host.config.mcpServers) return null;
  const active = Object.fromEntries(
    Object.entries(host.config.mcpServers).filter(([, cfg]) => !cfg?.disabled),
  );
  if (Object.keys(active).length === 0) return null;
  let mcp: McpManager | null = null;
  try {
    mcp = await acquireSharedMcp(active, {
      cwd: host.cwd,
      openAuthUrl: host.onMcpOpenAuthUrl ?? null,
    });
    if (!mcp) return null;
    if (host.onMcpServerRequest) {
      const unregister = mcp.setServerRequestHandler(
        async (server, method, params) => host.onMcpServerRequest!(server, method, params)
      );
      host.setMcpRequestHandlerCleanup?.(unregister);
    }
    for (const t of mcp.listAllTools()) {
 // Normalize the tool name to fit provider limits (64 chars) and
 // prevent collisions between long names. The original (server, name)
 // pair is captured in the closure so invocation is unaffected.
      const registeredName = normalizeMcpToolName(t.server, t.name);
 // Register a thin wrapper tool.
      host.withToolRegistry((registry) =>
        registry.register({
          name: registeredName,
          description: `[mcp:${t.server}] ${t.description}`,
          inputSchema: jsonSchemaToZod(t.inputSchema),
          permission: "network",
          source: "mcp",
          mcpMeta: { server: t.server, toolName: t.name, jsonSchema: t.inputSchema },
          execute: async (input) => {
            const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
            const r = await mcp!.invoke(t.server, t.name, args);
            return { content: r.content, isError: r.isError };
          },
        })
      );
    }
    return mcp;
  } catch (err) {
    process.stderr.write(
      `[session] MCP startup failed: ${(err as Error).message}\n`
    );
    return mcp;
  }
}

/** Resolve `@mcp:<server>/<uri>` references into inline resource content.
 * This lets users paste MCP resource URIs into their prompt to inject
 * server-side context (e.g. `@mcp:github/repos/foo/bar`). Best-effort:
 * failures leave the prompt untouched. */
export async function resolveSessionMcpReferences(
  mcp: McpManager | null,
  prompt: string
): Promise<string> {
  if (!mcp || !prompt.includes("@mcp:")) return prompt;
  try {
    const { text: resolved, resolved: n } = await resolveMcpReferences(prompt, mcp);
    if (n > 0) {
      return `${resolved}\n\n---\n(user prompt)\n${prompt}`;
    }
  } catch {
 /* best-effort: leave the prompt untouched */
  }
  return prompt;
}

// A tiny helper to convert a JSON Schema to a Zod schema. Only the features
// we actually expect from MCP servers (object with string/number/boolean
// properties, optional required array) are supported.
export function jsonSchemaToZod(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  return compileJsonSchema(schema);
}

export function compileJsonSchema(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  if (schema.type === "object" || schema.properties) {
    const shape: Record<string, import("zod").ZodTypeAny> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const [k, v] of Object.entries(props)) {
      let child = compileJsonSchema(v);
      if (!required.includes(k)) child = child.optional();
      shape[k] = child;
    }
    return z.object(shape).passthrough();
  }
  if (schema.type === "array") {
    return z.array(compileJsonSchema((schema.items as Record<string, unknown>) ?? {}));
  }
  if (schema.type === "number" || schema.type === "integer") return z.number();
  if (schema.type === "boolean") return z.boolean();
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length === 0) return z.any();
 // Cast through unknown so TS doesn't reject the heterogeneous literal array.
    const literals = values.map((v) => z.literal(v as never));
    return z.union(literals as unknown as [import("zod").ZodTypeAny, import("zod").ZodTypeAny, ...import("zod").ZodTypeAny[]]);
  }
  return z.any();
}
