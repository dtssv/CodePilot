// Session-stable ProviderToolDef rendering for prompt-cache friendliness.
// Memoize by tool name until unregister; compact oversized MCP/plugin schemas
// (~5KB budget) so third-party defs don't bloat the tools prefix.

import type { ProviderToolDef } from "../providers/types.js";
import { zodToJsonSchema, type ToolDef } from "./types.js";
import {
  getMemoisedProviderToolDef,
  setMemoisedProviderToolDef,
} from "./schemaCacheMemo.js";
import { isDirectWireTool } from "./wirePolicy.js";

export {
  clearProviderToolDefMemo,
  invalidateProviderToolDef,
} from "./schemaCacheMemo.js";

/** Soft byte budget for a single MCP/plugin input schema (UTF-8 JSON). */
export const DEFAULT_COMPACT_TOOL_SCHEMA_BYTES = 5_000;

const MAX_COMPACT_SCHEMA_DEPTH = 3;

/**
 * Render a tool to a provider-facing def. Bytes are memoised by name so
 * repeated turns reuse the same `inputSchema` object (stable prefix).
 * MCP/plugin schemas over budget are compacted lossily.
 */
export function toProviderToolDef(tool: ToolDef): ProviderToolDef {
  const hit = getMemoisedProviderToolDef(tool.name);
  if (hit && hit.description === tool.description) return hit;

  let inputSchema: Record<string, unknown>;
  if (tool.mcpMeta?.jsonSchema && typeof tool.mcpMeta.jsonSchema === "object") {
    inputSchema = structuredClone(tool.mcpMeta.jsonSchema) as Record<string, unknown>;
  } else {
    inputSchema = zodToJsonSchema(tool.inputSchema);
  }

  // Compact when over budget. MCP/plugin schemas are the usual offenders.
  // Never lossily compact direct-wire builtins (task/plan/…) — keep schemas
  // intact for the model and for prompt-cache stability.
  if (
    !isDirectWireTool(tool) &&
    schemaJsonBytes(inputSchema) > DEFAULT_COMPACT_TOOL_SCHEMA_BYTES
  ) {
    compactToolSchema(inputSchema, DEFAULT_COMPACT_TOOL_SCHEMA_BYTES);
  }

  const def: ProviderToolDef = {
    name: tool.name,
    description: tool.description,
    inputSchema,
  };
  setMemoisedProviderToolDef(tool.name, def);
  return def;
}

function schemaJsonBytes(schema: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Best-effort schema shrink (Compatible pass order): strip nested
 * descriptions, drop definition tables, collapse deep objects. Stops once
 * under `maxBytes`. Top-level `type`/`properties`/`required` are preserved
 * as long as they fit after earlier passes.
 */
export function compactToolSchema(
  schema: Record<string, unknown>,
  maxBytes: number = DEFAULT_COMPACT_TOOL_SCHEMA_BYTES,
): Record<string, unknown> {
  const passes: Array<(v: unknown) => void> = [
    stripSchemaDescriptions,
    dropSchemaDefinitions,
    (v) => collapseDeepSchemaObjects(v, 0),
  ];
  for (const pass of passes) {
    if (schemaJsonBytes(schema) <= maxBytes) break;
    pass(schema);
  }
  return schema;
}

function stripSchemaDescriptions(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripSchemaDescriptions(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  delete o.description;
  for (const v of Object.values(o)) stripSchemaDescriptions(v);
}

function dropSchemaDefinitions(value: unknown): void {
  rewriteDefinitionRefsToEmpty(value);
  if (Array.isArray(value)) {
    for (const item of value) dropSchemaDefinitions(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  delete o.$defs;
  delete o.definitions;
  for (const [k, v] of Object.entries(o)) {
    if (k === "$defs" || k === "definitions") continue;
    dropSchemaDefinitions(v);
  }
}

function rewriteDefinitionRefsToEmpty(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteDefinitionRefsToEmpty(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if (
    typeof o.$ref === "string" &&
    (o.$ref.includes("/$defs/") || o.$ref.includes("/definitions/"))
  ) {
    delete o.$ref;
    if (o.type === undefined) o.type = "object";
  }
  for (const v of Object.values(o)) rewriteDefinitionRefsToEmpty(v);
}

function collapseDeepSchemaObjects(value: unknown, depth: number): void {
  if (Array.isArray(value)) {
    for (const item of value) collapseDeepSchemaObjects(item, depth);
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if (depth >= MAX_COMPACT_SCHEMA_DEPTH && o.type === "object") {
    for (const key of Object.keys(o)) {
      if (key === "type") continue;
      delete o[key];
    }
    return;
  }
  const nextDepth = o.type === "object" || o.properties ? depth + 1 : depth;
  for (const v of Object.values(o)) collapseDeepSchemaObjects(v, nextDepth);
}
