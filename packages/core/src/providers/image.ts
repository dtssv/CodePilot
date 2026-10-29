// Image generation adapter. Talks to any OpenAI-images-compatible endpoint
// (OpenAI `gpt-image-1` or a compatible gateway) over the standard
// `/images/generations` and `/images/edits` routes. Kept separate from the
// chat providers: image generation uses a different model/account and a
// different response shape (base64 image payloads, not a token stream).

import { fetchWithRetry } from "./retry.js";

export interface ImageGenRequest {
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  background?: string;
  /** Base64 (no data-URL prefix) input images for image-to-image editing. */
  images?: string[];
  signal?: AbortSignal;
}

export interface ImageGenResult {
  /** Raw base64 image bytes (no data-URL prefix). */
  base64: string;
  mediaType: string;
}

export interface ImageGenEndpoint {
  baseURL: string;
  apiKey: string;
  model: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function pickImage(json: unknown): ImageGenResult {
  const data = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (first?.b64_json) {
    return { base64: first.b64_json, mediaType: "image/png" };
  }
  // Some gateways return a URL instead of inline base64. We don't fetch it
  // here — surface a clear error so the caller can report it. Inline base64
  // is the portable path (works for remote/web clients too).
  if (first?.url) {
    throw new Error(
      "image endpoint returned a URL instead of inline base64; set response_format=b64_json or use a gateway that returns base64",
    );
  }
  throw new Error("image endpoint returned no image data");
}

/** Generate an image from a text prompt (text-to-image). */
export async function generateImage(
  endpoint: ImageGenEndpoint,
  req: ImageGenRequest,
): Promise<ImageGenResult> {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    prompt: req.prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (req.size) body.size = req.size;
  if (req.quality) body.quality = req.quality;
  if (req.style) body.style = req.style;
  if (req.background) body.background = req.background;

  const res = await fetchWithRetry(
    joinUrl(endpoint.baseURL, "images/generations"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    },
    { signal: req.signal },
  );
  if (!res.ok) {
    throw new Error(`image generation failed: HTTP ${res.status}: ${await safeText(res)}`);
  }
  return pickImage(await res.json());
}

/** Edit/transform existing image(s) with a text instruction (image-to-image).
 * Uses multipart/form-data as the OpenAI images/edits route expects. */
export async function editImage(
  endpoint: ImageGenEndpoint,
  req: ImageGenRequest,
): Promise<ImageGenResult> {
  const form = new FormData();
  form.set("model", endpoint.model);
  form.set("prompt", req.prompt);
  form.set("n", "1");
  form.set("response_format", "b64_json");
  if (req.size) form.set("size", req.size);
  if (req.quality) form.set("quality", req.quality);
  if (req.background) form.set("background", req.background);
  (req.images ?? []).forEach((b64, i) => {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    const blob = new Blob([bytes], { type: "image/png" });
    // OpenAI accepts a single `image` or an `image[]` array for multi-image.
    form.append(req.images && req.images.length > 1 ? "image[]" : "image", blob, `image-${i}.png`);
  });

  const res = await fetchWithRetry(
    joinUrl(endpoint.baseURL, "images/edits"),
    {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
      body: form,
      signal: req.signal,
    },
    { signal: req.signal },
  );
  if (!res.ok) {
    throw new Error(`image edit failed: HTTP ${res.status}: ${await safeText(res)}`);
  }
  return pickImage(await res.json());
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<no body>";
  }
}
