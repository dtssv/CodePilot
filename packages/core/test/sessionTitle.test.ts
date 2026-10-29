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

  it("strips echoed tool-call XML fragments", () => {
    // The exact failure seen in the wild: a path plus a stray closing tag
    // plus a Chinese meta fragment, produced by the small model echoing input.
    expect(sanitizeTitle("Users/zyf/source</arg_value>用户希望我分析几个")).toBeNull();
    expect(sanitizeTitle("添加 LSP 工具</parameter>")).toBe("添加 LSP 工具");
    expect(sanitizeTitle("<function_calls><invoke>editFile")).toBe("editFile");
  });

  it("rejects Chinese meta-reasoning leftovers", () => {
    expect(sanitizeTitle("用户希望我分析几个问题")).toBeNull();
    expect(sanitizeTitle("我来分析一下这个方案")).toBeNull();
    expect(sanitizeTitle("根据交接记录继续完成任务")).toBeNull();
    expect(sanitizeTitle("标题：查看飞书文档")).toBeNull();
  });

  it("rejects titles that are really filesystem paths", () => {
    expect(sanitizeTitle("/Users/zyf/source")).toBeNull();
    expect(sanitizeTitle("Users/zyf/workspace/java/CodePilot")).toBeNull();
    expect(sanitizeTitle("C:\\Users\\zyf\\src")).toBeNull();
  });
});

describe("deriveTitleFromText", () => {
  it("uses the first user sentence", () => {
    expect(deriveTitleFromText("查看一下我的飞书有哪些文档")).toBe("查看一下我的飞书有哪些文档");
  });

  it("drops tool-call markup from the deterministic fallback", () => {
    expect(deriveTitleFromText("修复标题生成</arg_value> bug")).toBe("修复标题生成 bug");
  });
});
