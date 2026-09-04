// Tool framework. Tools declare a JSON schema, a permission tier and an
// async execute function. The agent loop invokes them with parsed input.

import type { z } from "zod";
import type { ContentBlock } from "../types.js";
import type { ResolvedSandbox } from "../sandbox.js";

export type PermissionLevel = "read" | "write" | "execute" | "network";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Stash helper to spill large tool outputs to disk. */
  artifact(blob: string | Uint8Array, hint?: string): Promise<string>;
  /** Resolve an artifact reference back to its contents. */
  readArtifact(ref: string): Promise<string>;
  /**
   * Active sandbox policy. File tools MUST call `assertPathAllowedAsync`
   * before any I/O; bash wraps commands via `wrapCommand`. Optional so
   * test harnesses can construct minimal contexts (absent = mode "off").
   */
  sandbox?: ResolvedSandbox;
}

export interface ToolResult {
  /** Required plain-text content (sent back to the model as a tool_result). */
  content: string;
  isError?: boolean;
  /** Optional reference to a file on disk holding larger content. */
  artifactRef?: string;
  /** Optional structured blocks for richer UI use; not required. */
  blocks?: ContentBlock[];
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  permission: PermissionLevel;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Convert a Zod schema to a JSON Schema object that Anthropic / OpenAI accept.
 * Uses zod's built-in toJSONSchema if available, otherwise falls back to a
 * permissive schema built from field inspection (Zod v3 doesn't ship one).
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // zod v3 has a `_def` describing the schema; we walk it for the common cases.
  type Def = {
    typeName?: string;
    schema?: unknown;
    shape?: () => Record<string, z.ZodTypeAny>;
    description?: string;
    innerType?: z.ZodTypeAny;
    values?: Set<unknown>;
    value?: unknown;
    options?: z.ZodTypeAny[];
  };
  const def = (schema as unknown as { _def?: Def })._def;
  if (!def) return { type: "object", additionalProperties: true };
  const description = (schema as unknown as { description?: string }).description;
  switch (def.typeName) {
    case "ZodEffects": {
      // .refine()/.transform() wrappers — unwrap to the inner schema.
      return def.schema ? zodToJsonSchema(def.schema as z.ZodTypeAny) : {};
    }
    case "ZodDefault": {
      // .default(v) — unwrap; the property is optional from the caller's view.
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    }
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const child = zodToJsonSchema(v);
        const defK = (v as unknown as { _def?: { typeName?: string } })._def;
        const defaulted = defK?.typeName === "ZodDefault";
        if (defaulted || (v as unknown as { isOptional?: () => boolean }).isOptional?.()) {
          // leave off `required`
        } else {
          required.push(k);
        }
        properties[k] = child;
      }
      const out: Record<string, unknown> = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) out.required = required;
      if (description) out.description = description;
      return out;
    }
    case "ZodString": {
      const o: Record<string, unknown> = { type: "string" };
      if (description) o.description = description;
      return o;
    }
    case "ZodNumber": {
      const o: Record<string, unknown> = { type: "number" };
      if (description) o.description = description;
      return o;
    }
    case "ZodBoolean": {
      const o: Record<string, unknown> = { type: "boolean" };
      if (description) o.description = description;
      return o;
    }
    case "ZodArray": {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : { type: "string" };
      const o: Record<string, unknown> = { type: "array", items: inner };
      if (description) o.description = description;
      return o;
    }
    case "ZodEnum": {
      const values = def.values ? Array.from(def.values as Set<unknown>) : [];
      const o: Record<string, unknown> = { type: "string", enum: values };
      if (description) o.description = description;
      return o;
    }
    case "ZodOptional": {
      return def.innerType ? zodToJsonSchema(def.innerType) : { type: "string" };
    }
    case "ZodNullable": {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : { type: "string" };
      return { ...inner, nullable: true };
    }
    case "ZodUnion": {
      const options = def.options ?? [];
      return { anyOf: options.map((o) => zodToJsonSchema(o)) };
    }
    case "ZodLiteral": {
      return { type: typeof def.value, enum: [def.value] };
    }
    default: {
      const o: Record<string, unknown> = {};
      if (description) o.description = description;
      return o;
    }
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<S extends z.ZodTypeAny>(tool: ToolDef<S>): void {
    this.tools.set(tool.name, tool as unknown as ToolDef);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }
}
