import { describe, expect, it } from "vitest";
import { restoreUtf8Bom, stripUtf8Bom, UTF8_BOM } from "../src/tools/utf8Bom.js";

describe("utf8Bom helpers", () => {
  it("stripUtf8Bom detects and removes a leading BOM", () => {
    expect(stripUtf8Bom(`${UTF8_BOM}abc`)).toEqual({ text: "abc", hadBom: true });
    expect(stripUtf8Bom("abc")).toEqual({ text: "abc", hadBom: false });
  });

  it("restoreUtf8Bom is idempotent", () => {
    expect(restoreUtf8Bom("abc", true)).toBe(`${UTF8_BOM}abc`);
    expect(restoreUtf8Bom(`${UTF8_BOM}abc`, true)).toBe(`${UTF8_BOM}abc`);
    expect(restoreUtf8Bom("abc", false)).toBe("abc");
  });
});
