import { describe, expect, it } from "vitest";
import { sanitizeTitle, deriveTitleFromText } from "../src/session-utils.js";

describe("sanitizeTitle", () => {
  it("strips closed think blocks and keeps the answer", () => {
    expect(sanitizeTitle("<think>plan</think>飞书文档列表")).toBe("飞书文档列表");
  });

  it("rejects incomplete think-only model dumps", () => {
    expect(
      sanitizeTitle('<think>We need answer to user Chinese: "查看一下我的飞书有哪些文档" =…'),
    ).toBeNull();
  });

  it("rejects English meta-reasoning leftovers", () => {
    expect(sanitizeTitle("<think>We need answer title only according developer. User…")).toBeNull();
    expect(sanitizeTitle("We need answer title only according developer")).toBeNull();
  });

  it("keeps a normal Chinese title", () => {
    expect(sanitizeTitle("查看飞书文档")).toBe("查看飞书文档");
  });
});

describe("deriveTitleFromText", () => {
  it("uses the first user sentence", () => {
    expect(deriveTitleFromText("查看一下我的飞书有哪些文档")).toBe("查看一下我的飞书有哪些文档");
  });
});
