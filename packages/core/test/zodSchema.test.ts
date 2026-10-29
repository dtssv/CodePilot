import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../src/tools/types.js";

/**
 * Regression: zod stores an array's element schema under `_def.type`, not
 * `_def.innerType`. The old converter only looked at innerType and degraded
 * every array's items to {type:"string"} — nested-object arrays like
 * ask_user_question.questions arrived at the model without their item shape,
 * so the model omitted required fields ("questions.0.id: Required").
 */
describe("zodToJsonSchema arrays", () => {
  it("converts object-array items with their full shape", () => {
    const schema = z.object({
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            question: z.string(),
            opts: z.array(z.object({ label: z.string() })).optional(),
          })
        )
        .min(1)
        .max(4),
    });
    const out = zodToJsonSchema(schema) as {
      properties: {
        questions: {
          type: string;
          minItems?: number;
          maxItems?: number;
          items: {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          };
        };
      };
    };
    const q = out.properties.questions;
    expect(q.type).toBe("array");
    expect(q.minItems).toBe(1);
    expect(q.maxItems).toBe(4);
    expect(q.items.type).toBe("object");
    expect(Object.keys(q.items.properties)).toEqual(["id", "question", "opts"]);
    expect(q.items.required).toContain("id");
    expect(q.items.required).toContain("question");
    expect(q.items.required).not.toContain("opts");
 // Nested array inside the item must also be an object array.
    const opts = q.items.properties.opts as { type: string; items: { type: string } };
    expect(opts.type).toBe("array");
    expect(opts.items.type).toBe("object");
  });

  it("still converts primitive arrays", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const out = zodToJsonSchema(schema) as {
      properties: { tags: { type: string; items: { type: string } } };
    };
    expect(out.properties.tags.items.type).toBe("string");
  });
});

/**
 * Shape contract the three providers rely on. Anthropic/OpenAI take the schema
 * as-is; Gemini strips a few keys. These assertions pin the output so a future
 * library or option change can't silently alter what the model receives.
 */
describe("zodToJsonSchema provider shape contract", () => {
  it("marks objects as closed and omits a $schema header", () => {
    const out = zodToJsonSchema(z.object({ a: z.string() })) as Record<string, unknown>;
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toBe(false);
    expect(out.$schema).toBeUndefined();
    expect(out.$ref).toBeUndefined();
    expect(out.$defs).toBeUndefined();
  });

  it("renders nullable as OpenAPI-style `nullable: true`, not anyOf", () => {
    const out = zodToJsonSchema(z.object({ x: z.boolean().nullable() })) as {
      properties: { x: Record<string, unknown> };
    };
    expect(out.properties.x.type).toBe("boolean");
    expect(out.properties.x.nullable).toBe(true);
    expect(out.properties.x.anyOf).toBeUndefined();
  });

  it("keeps enums, integers, and optional/required split", () => {
    const schema = z.object({
      action: z.enum(["go", "stop"]),
      count: z.number().int(),
      note: z.string().optional(),
    });
    const out = zodToJsonSchema(schema) as {
      properties: { action: { enum: string[] }; count: { type: string } };
      required: string[];
    };
    expect(out.properties.action.enum).toEqual(["go", "stop"]);
    expect(out.properties.count.type).toBe("integer");
    expect(out.required).toContain("action");
    expect(out.required).toContain("count");
    expect(out.required).not.toContain("note");
  });

  it("inlines reused sub-schemas instead of emitting $ref", () => {
    const item = z.object({ label: z.string() });
    const schema = z.object({ a: item, b: item });
    const json = JSON.stringify(zodToJsonSchema(schema));
    expect(json).not.toContain("$ref");
    expect(json).not.toContain("$defs");
    expect(json).not.toContain("definitions");
  });
});

/**
 * Root cause of an intermittent `400 invalid_argument` on the GLM/jdcloud
 * gateway: `target: "openApi3"` emits the DRAFT-04 boolean exclusivity form
 * (`{ minimum: 0, exclusiveMinimum: true }`) for Zod's `.positive()` / `.gt()`
 * / `.lt()`. OpenAI's API and strict gateways speak draft 2020-12, where
 * `exclusiveMinimum`/`exclusiveMaximum` are NUMBERS; the boolean form made the
 * gateway reject the WHOLE request whenever a tool using `.positive()`/`.max()`
 * (bash's `timeout`, web_fetch, grep, …) was present. It looked order-dependent
 * but was purely this schema-dialect mismatch. We normalize to the numeric form.
 */
describe("zodToJsonSchema numeric exclusivity (draft-2020-12)", () => {
  it("converts .positive() to numeric exclusiveMinimum, dropping the boolean", () => {
    const out = zodToJsonSchema(z.object({ timeout: z.number().int().positive().max(600_000) })) as {
      properties: { timeout: Record<string, unknown> };
    };
    const t = out.properties.timeout;
    expect(t.exclusiveMinimum).toBe(0); // numeric, not `true`
    expect(typeof t.exclusiveMinimum).toBe("number");
    expect("minimum" in t).toBe(false); // the paired inclusive bound is gone
    expect(t.maximum).toBe(600_000); // inclusive max untouched
  });

  it("converts .gt()/.lt() to numeric exclusive bounds", () => {
    const out = zodToJsonSchema(z.object({ n: z.number().gt(5).lt(10) })) as {
      properties: { n: Record<string, unknown> };
    };
    const n = out.properties.n;
    expect(n.exclusiveMinimum).toBe(5);
    expect(n.exclusiveMaximum).toBe(10);
    expect("minimum" in n).toBe(false);
    expect("maximum" in n).toBe(false);
  });

  it("leaves inclusive .min()/.max() as plain minimum/maximum", () => {
    const out = zodToJsonSchema(z.object({ n: z.number().min(1).max(4) })) as {
      properties: { n: Record<string, unknown> };
    };
    const n = out.properties.n;
    expect(n.minimum).toBe(1);
    expect(n.maximum).toBe(4);
    expect("exclusiveMinimum" in n).toBe(false);
    expect("exclusiveMaximum" in n).toBe(false);
  });

  it("no serialized tool schema contains a boolean exclusive bound", () => {
    // Belt-and-braces: the whole emitted schema must never carry the draft-04
    // boolean form that the gateway rejects.
    const schema = z.object({
      a: z.number().positive(),
      nested: z.object({ b: z.number().gt(0).lt(100) }),
      arr: z.array(z.object({ c: z.number().positive() })),
    });
    const json = JSON.stringify(zodToJsonSchema(schema));
    expect(json).not.toContain('"exclusiveMinimum":true');
    expect(json).not.toContain('"exclusiveMaximum":true');
    expect(json).not.toContain('"exclusiveMinimum":false');
    expect(json).not.toContain('"exclusiveMaximum":false');
  });
});
