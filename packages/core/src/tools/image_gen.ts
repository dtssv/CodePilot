// image_gen: generate an image from a text prompt, or edit/transform existing
// image(s) when input images are supplied. Calls a separate, configurable
// image model (config.imageGen) — the tool is only registered when that
// endpoint is configured, since not every provider can generate images.
//
// Output lands in the workspace (default `generated-images/`) and the tool
// returns the RELATIVE path, so web/remote clients can view it through the
// existing workspace image preview (served as base64 over the protocol).

import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardPath } from "./_shared.js";
import type { ImageGenConfig } from "../types.js";
import { editImage, generateImage, type ImageGenEndpoint } from "../providers/image.js";

const schema = z.object({
  prompt: z.string().describe("Required. Text description of the image to generate or the edit to apply."),
  size: z.string().optional().describe('Image size in pixels, e.g. "1024x1024", "1024x1536", "1536x1024".'),
  quality: z.string().optional().describe("Quality hint: low, medium, high."),
  style: z.string().optional().describe("Optional style hint."),
  background: z.string().optional().describe("Background: transparent or opaque."),
  output_dir: z
    .string()
    .optional()
    .describe("Output directory (relative to cwd). Defaults to `generated-images/`."),
  image1: z
    .string()
    .optional()
    .describe("First input image for image-to-image editing: a local path or http(s) URL. When set, performs an edit instead of a fresh generation."),
  image2: z.string().optional().describe("Optional second input image. Use with image1."),
  image3: z.string().optional().describe("Optional third input image. Use with image1 and image2."),
});

/** Build the resolved endpoint from config, or null when not usable. */
export function resolveImageEndpoint(cfg: ImageGenConfig | undefined): ImageGenEndpoint | null {
  if (!cfg || cfg.enabled === false) return null;
  const baseURL = cfg.baseURL?.trim();
  const apiKey = cfg.apiKey?.trim();
  if (!baseURL || !apiKey) return null;
  return { baseURL, apiKey, model: cfg.model?.trim() || "gpt-image-1" };
}

async function loadInputImage(ref: string, ctx: { cwd: string }, signal?: AbortSignal): Promise<string> {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { signal });
    if (!res.ok) throw new Error(`failed to fetch input image ${ref}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  }
  const buf = await readFile(resolve(ctx.cwd, ref));
  return buf.toString("base64");
}

function extForMedia(mediaType: string): string {
  if (mediaType.includes("jpeg")) return ".jpg";
  if (mediaType.includes("webp")) return ".webp";
  return ".png";
}

export const imageGenTool: ToolDef<typeof schema> & { config?: ImageGenConfig } = {
  name: "image_gen",
  description:
    "Generate an image from a text description, or edit/transform existing image(s) when `image1` is provided. " +
    "Image generation uses a separate image model and may incur additional cost — tell the user about the likely " +
    "credit/cost before generating. Output is saved into the workspace (default `generated-images/`) and the " +
    "relative path is returned so it can be previewed.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const endpoint = resolveImageEndpoint(this.config);
    if (!endpoint) {
      return {
        content:
          "image generation is not configured. Set `imageGen.baseURL` and `imageGen.apiKey` in your CodePilot config to enable it.",
        isError: true,
      };
    }
    if (!input.prompt?.trim()) {
      return { content: "prompt is required", isError: true };
    }

    const outDir = input.output_dir?.trim() || "generated-images";
    const inputRefs = [input.image1, input.image2, input.image3].filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );

    // Destination path (write-guarded like any other workspace write).
    const guard = await guardPath(ctx, outDir, "write");
    if (guard) return guard;

    let result: { base64: string; mediaType: string };
    try {
      if (inputRefs.length > 0) {
        const images = await Promise.all(inputRefs.map((r) => loadInputImage(r, ctx, ctx.signal)));
        result = await editImage(endpoint, {
          prompt: input.prompt,
          size: input.size,
          quality: input.quality,
          background: input.background,
          images,
          signal: ctx.signal,
        });
      } else {
        result = await generateImage(endpoint, {
          prompt: input.prompt,
          size: input.size,
          quality: input.quality,
          style: input.style,
          background: input.background,
          signal: ctx.signal,
        });
      }
    } catch (err) {
      return { content: `image generation failed: ${(err as Error).message}`, isError: true };
    }

    const ext = extForMedia(result.mediaType);
    const fileRel = join(outDir, `image-${Date.now()}${ext}`);
    const abs = resolve(ctx.cwd, fileRel);
    const delivery = await guardDeliveryWrite(ctx, fileRel);
    if (delivery) return delivery;
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(result.base64, "base64"));
    } catch (err) {
      return { content: `failed to save generated image: ${(err as Error).message}`, isError: true };
    }

    const action = inputRefs.length > 0 ? "edited" : "generated";
    return {
      content: `Image ${action} and saved to \`${fileRel}\`. Open it in the workspace to preview.`,
    };
  },
};
