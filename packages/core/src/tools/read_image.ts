// read_image: load an image file and return it to the model as a
// multimodal image block. Supports jpeg/png/gif/webp; other formats are
// refused. Oversized images are auto-downscaled via host sips/magick before
// attach.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";
import { IMAGE_MAX_DIMENSION, maybeDownsampleImage } from "./imageDownsample.js";

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
    "See the pixels of an image file (jpeg/png/gif/webp) when visual inspection is " +
    "needed. Not for text (`read_file`) or raw bytes (`bash`). Don't reload images " +
    "already in context or user attachments. Large images are downscaled automatically " +
    `(long edge ≤ ${IMAGE_MAX_DIMENSION}px); sandbox paths only.`,
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "read");
    if (guard) return guard;
    const modelId = ctx.config?.model;
    const providerId = ctx.config?.provider;
    const caps =
      modelId && providerId
        ? (
            ctx.config as {
              providers?: Record<
                string,
                { modelCapabilities?: Record<string, { modalities?: string[] }> }
              >;
            }
          ).providers?.[providerId]?.modelCapabilities?.[modelId]
        : undefined;
    const modalities = caps?.modalities;
    if (modalities && !modalities.includes("image")) {
      return {
        content:
          `Current model (${modelId}) does not advertise image/vision input ` +
          `(modalities: ${modalities.join(", ")}). Describe the image in text, ` +
          `switch to a vision-capable model, or omit read_image.`,
        isError: true,
      };
    }
    const ext = extname(input.path).toLowerCase();
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
    // Prefer extension; fall back to magic bytes (screenshots / paste dumps).
    let mediaType: string =
      IMAGE_MEDIA_TYPES[ext] ?? sniffImageMediaType(buf) ?? "";
    if (!mediaType) {
      return {
        content:
          `unsupported image format "${ext || "(none)"}". Accepted: ` +
          Object.keys(IMAGE_MEDIA_TYPES).join(", ") +
          ` (or magic-byte sniffable jpeg/png/gif/webp).`,
        isError: true,
      };
    }

    const scaled = await maybeDownsampleImage(buf, input.path, MAX_IMAGE_BYTES);
    if (scaled.error && !scaled.downscaled) {
      // Soft fallback: if under byte cap, still attach original with a note.
      if (buf.length <= MAX_IMAGE_BYTES) {
        /* keep buf; note in result below via scaleNote path */
      } else {
        return {
          content:
            `${scaled.error}. Install ImageMagick (\`magick\`) or use macOS \`sips\`, ` +
            `or shrink the image under ${MAX_IMAGE_BYTES.toLocaleString()} bytes.`,
          isError: true,
        };
      }
    }
    buf = scaled.buf;
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        content:
          `image is still ${buf.length.toLocaleString()} bytes after downscale ` +
          `(> ${MAX_IMAGE_BYTES.toLocaleString()} limit).`,
        isError: true,
      };
    }
    // GIF may have been rewritten to PNG by the host tool.
    if (scaled.downscaled && (ext === ".gif" || mediaType === "image/gif")) {
      mediaType = "image/png";
    }

    const base64 = buf.toString("base64");
    const note = input.note ? ` (${input.note})` : "";
    let scaleNote = "";
    if (scaled.downscaled && scaled.original && scaled.prepared) {
      const x = (scaled.original.width / scaled.prepared.width).toFixed(2);
      const y = (scaled.original.height / scaled.prepared.height).toFixed(2);
      const advice =
        x === y
          ? `multiply coordinates by ${x}`
          : `multiply x by ${x} and y by ${y}`;
      scaleNote =
        ` (downscaled from ${scaled.original.width}x${scaled.original.height} px via ${scaled.tool}; ` +
        `${advice} to locate features in the original file)`;
    } else if (scaled.prepared) {
      scaleNote = ` ${scaled.prepared.width}x${scaled.prepared.height} px`;
    }
    return {
      content:
        `Loaded image ${input.path}${note} — ${mediaType}, ${buf.length.toLocaleString()} bytes` +
        `${scaleNote}. The image is attached to this tool result as a vision block.`,
      images: [{ mediaType, base64 }],
    };
  },
};

/** Detect jpeg/png/gif/webp from leading magic bytes when the path has no/odd ext. */
export function sniffImageMediaType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x39 || buf[4] === 0x37) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
