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
