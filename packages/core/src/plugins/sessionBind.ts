// Plugin runtime toolkit: context transform, event sink, and contributed tools.
// Extracted from Session (move-only split).

import type { PluginToolDef } from "../agent/runtime.js";
import type { ProviderMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/types.js";
import { BoundedSinkQueue, type SessionEventSink } from "../session/sessionSink.js";
import { jsonSchemaToZod } from "../mcp/sessionBind.js";

export type PluginHost = {
  pluginContextTransform:
    | ((view: ProviderMessage[]) => ProviderMessage[])
    | undefined;
  eventSink: BoundedSinkQueue | undefined;
  toolRegistry: ToolRegistry;
};

/**
 * Install a plugin-provided context transform. The ABI type
 * `PluginContextTransform` is the structural twin of a transform over
 * `ProviderMessage[]`, so this stores it directly; `agent.ts` applies it on
 * a copy of the view, validates the result, and falls back to the
 * untransformed view on any problem (fail-soft). Setting it again replaces
 * the previous transform.
 */
export function setPluginContextTransform(
  host: PluginHost,
  transform: (view: ProviderMessage[]) => ProviderMessage[],
): void {
  host.pluginContextTransform = transform;
}

/**
 * Register a plugin-provided additive event sink. The sink is wrapped in a
 * {@link BoundedSinkQueue} so it mirrors JSONL lines on a background drain
 * and can never block or fail the canonical append (fail-soft enforced by
 * the host). Registering again closes the previous sink and installs the
 * new one. The ABI `PluginEventSink` is the structural twin of
 * `SessionEventSink`, so it is stored directly.
 */
export function registerPluginEventSink(
  host: PluginHost,
  sink: SessionEventSink,
): void {
  const prev = host.eventSink;
  host.eventSink = new BoundedSinkQueue(sink, {
    onError: (err) =>
      process.stderr.write(`[session] event sink error: ${err.message}\n`),
  });
  if (prev) void prev.close();
}

/**
 * Adapt a plugin-contributed {@link PluginToolDef} into a real registry
 * entry the model can call. The JSON-schema input is converted to Zod with
 * the same helper MCP tools use (`jsonSchemaToZod`), so it type-checks and
 * flows through the normal validation + PreToolUse/PostToolUse + permission
 * pipeline. A plugin tool may NOT overwrite a built-in (or earlier plugin)
 * tool of the same name — the first registration wins and later ones are
 * rejected with a warning, so a plugin cannot silently hijack `bash`/`read_file`.
 */
export function registerPluginTool(host: PluginHost, def: PluginToolDef): void {
  const name = typeof def?.name === "string" ? def.name.trim() : "";
  if (!name) throw new Error("plugin tool is missing a name");
  if (host.toolRegistry.get(name)) {
    process.stderr.write(
      `[session] plugin tool "${name}" ignored — a tool with that name already exists\n`,
    );
    return;
  }
  const schema =
    def.parameters && typeof def.parameters === "object"
      ? def.parameters
      : { type: "object", properties: {} };
  host.toolRegistry.register({
    name,
    description: typeof def.description === "string" ? def.description : "",
    inputSchema: jsonSchemaToZod(schema as Record<string, unknown>),
    permission: def.permission ?? "execute",
    source: "plugin",
    execute: async (input, ctx) => {
      // Run the plugin's handler with an ABI-safe context subset. Any throw
      // becomes an error tool_result, never a crash (fail-soft).
      try {
        const r = await def.execute(input, { cwd: ctx.cwd, signal: ctx.signal });
        return {
          content:
            typeof r?.content === "string" ? r.content : String(r?.content ?? ""),
          isError: r?.isError === true,
        };
      } catch (err) {
        return {
          content: `plugin tool "${name}" failed: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  });
}