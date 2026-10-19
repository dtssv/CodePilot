// Browser-side image intake for the composer: paste / drop / file picker all
// funnel through `readImageFile`, which downscales oversized pictures so a
// phone photo or a 4K screenshot stays within provider per-image limits.

import type { ImageAttachment } from "@codepilot/core";

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Longest edge sent to the model; providers downsample beyond this anyway. */
const MAX_EDGE = 2000;
/** Stay under the strictest common per-image cap (Anthropic: 5MB base64). */
const MAX_BYTES = 3_500_000;

export interface PendingImage extends ImageAttachment {
  id: string;
  name: string;
}

export function imageDataUrl(img: ImageAttachment): string {
  return `data:${img.mediaType};base64,${img.base64}`;
}

export function imageFilesFrom(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
}

export async function readImageFile(file: File): Promise<PendingImage> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = file.name || "pasted image";
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close();
    return { id, name, mediaType: file.type, base64: await blobBase64(file) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob = await canvasBlob(canvas, "image/png");
  if (blob.size > MAX_BYTES) blob = await canvasBlob(canvas, "image/jpeg", 0.88);
  return { id, name, mediaType: blob.type, base64: await blobBase64(blob) };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image encode failed"))), type, quality),
  );
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}
