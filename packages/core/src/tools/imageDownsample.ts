// Host-tool image downscale (auto-resize before vision).
// Prefer `sips` (macOS) or ImageMagick `magick`/`convert` — same tools we
// previously asked the model to run by hand. No native sharp dependency
// (compiled CLI ABI surface stays small).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

/** Long-edge cap matching prior read_image guidance (`sips -Z 2000`). */
export const IMAGE_MAX_DIMENSION = 2000;

export type ImageDimensions = { width: number; height: number };

/** Best-effort PNG/JPEG/GIF/WebP dimension probe (no decode lib). */
export function probeImageDimensions(buf: Buffer): ImageDimensions | null {
  // PNG: IHDR after 8-byte signature
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: scan for SOF0/2
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // WebP VP8X / VP8
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const tag = buf.toString("ascii", 12, 16);
    if (tag === "VP8X" && buf.length >= 30) {
      const w = 1 + buf[24]! + (buf[25]! << 8) + (buf[26]! << 16);
      const h = 1 + buf[27]! + (buf[28]! << 8) + (buf[29]! << 16);
      return { width: w, height: h };
    }
    if (tag === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

function needsDownsample(buf: Buffer, maxBytes: number): {
  needed: boolean;
  dims: ImageDimensions | null;
} {
  const dims = probeImageDimensions(buf);
  const tooBigBytes = buf.length > maxBytes;
  const tooBigDims =
    dims !== null && Math.max(dims.width, dims.height) > IMAGE_MAX_DIMENSION;
  return { needed: tooBigBytes || tooBigDims, dims };
}

async function runHost(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(false);
    }, 60_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Downscale `buf` to fit {@link IMAGE_MAX_DIMENSION} via sips/magick when
 * needed. Returns original buffer when already within limits or no host tool
 * is available.
 */
export async function maybeDownsampleImage(
  buf: Buffer,
  pathHint: string,
  maxBytes: number,
): Promise<{
  buf: Buffer;
  downscaled: boolean;
  original?: ImageDimensions;
  prepared?: ImageDimensions;
  tool?: string;
  error?: string;
}> {
  const { needed, dims } = needsDownsample(buf, maxBytes);
  if (!needed) {
    return { buf, downscaled: false, original: dims ?? undefined, prepared: dims ?? undefined };
  }

  const ext = extname(pathHint).toLowerCase() || ".png";
  const dir = await mkdtemp(join(tmpdir(), "cp-img-"));
  const src = join(dir, `src${ext}`);
  const dst = join(dir, `out${ext === ".gif" ? ".png" : ext}`);
  try {
    await writeFile(src, buf);

    let tool: string | undefined;
    let ok = false;
    if (process.platform === "darwin") {
      ok = await runHost("sips", ["-Z", String(IMAGE_MAX_DIMENSION), src, "--out", dst]);
      if (ok) tool = "sips";
    }
    if (!ok) {
      ok = await runHost("magick", [src, "-resize", `${IMAGE_MAX_DIMENSION}x${IMAGE_MAX_DIMENSION}>`, dst]);
      if (ok) tool = "magick";
    }
    if (!ok) {
      ok = await runHost("convert", [src, "-resize", `${IMAGE_MAX_DIMENSION}x${IMAGE_MAX_DIMENSION}>`, dst]);
      if (ok) tool = "convert";
    }
    if (!ok) {
      return {
        buf,
        downscaled: false,
        original: dims ?? undefined,
        error:
          `image exceeds ${maxBytes.toLocaleString()} bytes or ${IMAGE_MAX_DIMENSION}px and no ` +
          `host downsampler (sips/magick/convert) succeeded`,
      };
    }
    const out = await readFile(dst);
    const prepared = probeImageDimensions(out) ?? undefined;
    return {
      buf: out,
      downscaled: true,
      original: dims ?? undefined,
      prepared,
      tool,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
