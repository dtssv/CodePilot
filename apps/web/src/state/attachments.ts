// Browser-side attachment intake for the composer. Images become vision
// blocks; every other file is base64'd and written under `.codepilot/uploads/`
// by the server so the model can read it with the normal file tools.

import type { ImageAttachment, PromptFile } from "@codepilot/core";
import {
  ACCEPTED_IMAGE_TYPES,
  imageDataUrl,
  readImageFile,
  type PendingImage,
} from "./images.js";

export { ACCEPTED_IMAGE_TYPES, imageDataUrl, type PendingImage };

/** Soft cap for non-image uploads (server also enforces 20MB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface PendingFile {
  id: string;
  name: string;
  mediaType: string;
  base64: string;
  bytes: number;
}

export type PendingAttachment =
  | ({ kind: "image" } & PendingImage)
  | ({ kind: "file" } & PendingFile);

export function filesFromList(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []);
}

export function isImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

export async function readAttachment(file: File): Promise<PendingAttachment> {
  if (isImageFile(file)) {
    const img = await readImageFile(file);
    return { kind: "image", ...img };
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${file.size.toLocaleString()} bytes exceeds the ${MAX_FILE_BYTES.toLocaleString()}-byte limit`,
    );
  }
  const base64 = await blobBase64(file);
  return {
    kind: "file",
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "upload",
    mediaType: file.type || "application/octet-stream",
    base64,
    bytes: file.size,
  };
}

export function splitAttachments(items: PendingAttachment[]): {
  images: ImageAttachment[];
  files: PromptFile[];
} {
  const images: ImageAttachment[] = [];
  const files: PromptFile[] = [];
  for (const a of items) {
    if (a.kind === "image") {
      images.push({ mediaType: a.mediaType, base64: a.base64 });
    } else {
      files.push({ name: a.name, mediaType: a.mediaType, base64: a.base64 });
    }
  }
  return { images, files };
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}
