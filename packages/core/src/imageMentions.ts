// `@path/to/image.png` mentions in a prompt: the referenced files are read and
// attached to the user message as images, so any front end (web, CLI, TUI)
// can hand the model a picture by path.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { ImageAttachment } from "./types.js";
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from "./tools/read_image.js";

const MENTION = /(?<![\w.])@("[^"\n]+"|[^\s"'`，。；：！？、（）【】《》]+)/g;
const TRAILING_PUNCT = /[,.;:!?)]+$/;

export interface ImageMentionResult {
  images: ImageAttachment[];
 /** Mentions that looked like images but could not be attached, with why. */
  failures: string[];
}

export async function resolveImageMentions(text: string, cwd: string): Promise<ImageMentionResult> {
  const images: ImageAttachment[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    let raw = m[1]!;
    raw = raw.startsWith('"') ? raw.slice(1, -1) : raw.replace(TRAILING_PUNCT, "");
    const mediaType = IMAGE_MEDIA_TYPES[extname(raw).toLowerCase()];
    if (!mediaType) continue;
    const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const buf = await readFile(abs);
      if (buf.length > MAX_IMAGE_BYTES) {
        failures.push(`${raw}: ${buf.length.toLocaleString()} bytes exceeds the ${MAX_IMAGE_BYTES.toLocaleString()}-byte limit`);
        continue;
      }
      images.push({ mediaType, base64: buf.toString("base64") });
    } catch (err) {
      failures.push(`${raw}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  }
  return { images, failures };
}
