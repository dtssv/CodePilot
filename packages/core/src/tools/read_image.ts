// read_image: load an image file from disk and return it to the model as
// a multimodal image block. The agent uses this to "see" screenshots,
// diagrams, photos, or any image that's part of the task — e.g. a UI
// screenshot to reproduce, a chart to analyse, a design mockup to implement.
//
// Supported formats: jpeg, png, gif, webp (the set the major multimodal
// providers accept). Other formats are refused with a clear message.
// Large images are NOT spilled to an artifact — providers downsample
// internally — but we cap the encoded size to avoid blowing the context
// window on a 50MB raw photo.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB raw → ~27MB base64

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const schema = z.object({
  path: z.string().describe("Path to the image file (jpeg/png/gif/webp)."),
 /** Optional one-line note the agent wants attached to the image, e.g.
 * "screenshot of the failing test" — helps the model reason about what
 * it's looking at. */
  note: z
    .string()
    .optional()
    .describe("Optional context note describing what the image shows."),
});

export const readImageTool: ToolDef<typeof schema> = {
  name: "read_image",
  description:
    "See image pixels (jpeg/png/gif/webp): mockups, reference GIFs, UI screenshots, " +
    "diagrams. For visual/replication tasks: study the reference thoroughly *before* " +
    "coding (sample key frames — not a capture loop); re-check screenshots at milestones " +
    "or near done, not after every tiny edit. Not for text (`read_file`) or raw bytes " +
    "(`bash`). Don't reload images already in context or user attachments. Max 20MB; " +
    "sandbox paths only.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "read");
    if (guard) return guard;
    const ext = extname(input.path).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      return {
        content:
          `unsupported image format "${ext || "(none)"}". Accepted: ` +
          Object.keys(IMAGE_MEDIA_TYPES).join(", "),
        isError: true,
      };
    }
    const p = resolve(ctx.cwd, input.path);
    let buf: Buffer;
    try {
      buf = await readFile(p);
    } catch (err) {
      return {
        content: `failed to read ${input.path}: ${(err as Error).message}`,
        isError: true,
      };
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        content:
          `image is ${buf.length.toLocaleString()} bytes (> ${MAX_IMAGE_BYTES.toLocaleString()} ` +
          `limit). Downsample it first, e.g. with \`sips -Z 2000 ${input.path}\` (macOS) ` +
          `or \`convert ${input.path} -resize 2000x2000\\> out.png\` (ImageMagick).`,
        isError: true,
      };
    }
    const base64 = buf.toString("base64");
    const note = input.note ? ` (${input.note})` : "";
    return {
      content: `Loaded image ${input.path}${note} — ${mediaType}, ${buf.length.toLocaleString()} bytes. The image is attached to this tool result as a vision block.`,
      images: [{ mediaType, base64 }],
    };
  },
};
