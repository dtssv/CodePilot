import { describe, expect, it } from "vitest";
import { probeImageDimensions, IMAGE_MAX_DIMENSION } from "../src/tools/imageDownsample.js";

/** Minimal 1×1 PNG. */
function tinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}

describe("probeImageDimensions", () => {
  it("reads PNG IHDR", () => {
    const d = probeImageDimensions(tinyPng());
    expect(d).toEqual({ width: 1, height: 1 });
  });

  it("returns null for non-images", () => {
    expect(probeImageDimensions(Buffer.from("not an image"))).toBeNull();
  });
});

describe("IMAGE_MAX_DIMENSION", () => {
  it("matches prior sips -Z guidance", () => {
    expect(IMAGE_MAX_DIMENSION).toBe(2000);
  });
});
