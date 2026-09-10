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

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB raw → ~27MB base64

const EXT_TO_MEDIA: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const schema = z.object({
  path: z.string().describe("Path to the image file (jpeg/png/gif/webp)."),
  /** Optional one-line note the agent wants attached to the image, e.g.
   *  "screenshot of the failing test" — helps the model reason about what
   *  it's looking at. */
  note: z
    .string()
    .optional()
    .describe("Optional context note describing what the image shows."),
});

export const readImageTool: ToolDef<typeof schema> = {
  name: "read_image",
  description:
    "Load an image file from disk and return it so you can SEE it (jpeg, " +
    "png, gif, webp). Use this when the task involves a visual: a UI " +
    "screenshot to reproduce, a diagram to explain, a chart to analyse, a " +
    "design mockup to implement, or an error dialog to debug.\n\n" +
    "When to use: any task where seeing the pixels matters more than " +
    "reading the bytes. The image is returned as a vision block alongside " +
    "a short text confirmation.\n\n" +
    "When NOT to use: text files (use `read_file`), binary blobs you need " +
    "to inspect as bytes (use `bash` with `xxd`/`file`), or images you " +
    "already loaded this turn (re-loading wastes a tool call — the image " +
    "is still in context).\n\n" +
    "Gotchas: the path must resolve inside the sandbox. Files over 20MB are " +
    "refused (downsample first). Unsupported extensions are refused with the " +
    "accepted list.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "read");
    if (guard) return guard;
    const ext = extname(input.path).toLowerCase();
    const mediaType = EXT_TO_MEDIA[ext];
    if (!mediaType) {
      return {
        content:
          `unsupported image format "${ext || "(none)"}". Accepted: ` +
          Object.keys(EXT_TO_MEDIA).join(", "),
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
