import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImageMentions } from "../src/imageMentions.js";
import { compactTranscriptToProviderMessages } from "../src/agent-messages.js";
import type { Event } from "../src/types.js";

describe("resolveImageMentions", () => {
  it("attaches @-mentioned image files and reports missing ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "img-"));
    mkdirSync(join(dir, "design"));
    writeFileSync(join(dir, "design", "home.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, "my shot.JPG"), Buffer.from([4]));
    const r = await resolveImageMentions(
      '照着@design/home.png，以及 @"my shot.JPG" 复刻页面；@missing.webp。@notes.md 不是图片',
      dir,
    );
    expect(r.images).toEqual([
      { mediaType: "image/png", base64: Buffer.from([1, 2, 3]).toString("base64") },
      { mediaType: "image/jpeg", base64: Buffer.from([4]).toString("base64") },
    ]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/^missing\.webp: ENOENT/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores e-mail addresses and plain text", async () => {
    const r = await resolveImageMentions("mail me at a@b.png.com or see logo.png", "/tmp");
    expect(r).toEqual({ images: [], failures: [] });
  });
});

describe("user message images", () => {
  it("are re-sent from the persisted event on later turns", () => {
    const img = { mediaType: "image/png", base64: "AAAA" };
    const events: Event[] = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "复刻这个界面" }], images: [img] },
      { type: "message", id: "a1", role: "assistant", content: [{ type: "text", text: "done" }] },
      { type: "message", id: "u2", role: "user", content: [{ type: "text", text: "按钮再圆一点" }] },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "");
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: "复刻这个界面" },
      { type: "image", mediaType: "image/png", base64: "AAAA" },
    ]);
    expect(msgs[2]!.content).toEqual([{ type: "text", text: "按钮再圆一点" }]);
  });

  it("are not duplicated when the run also passes them in", () => {
    const img = { mediaType: "image/png", base64: "AAAA" };
    const events: Event[] = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }], images: [img] },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "hi", [img], "u1");
    expect(msgs[0]!.content.filter((c) => c.type === "image")).toHaveLength(1);
  });
});

describe("uploaded files in provider messages", () => {
  it("keeps the user bubble text clean and injects the note for the model", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "帮我分析一下该文件的平均薪资" }],
        files: [{ name: "test.xlsx", path: "/Users/me/.codepilot/projects/abc/uploads/test.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: 8290 }],
      },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "");
    const text = msgs[0]!.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("帮我分析一下该文件的平均薪资");
    expect(text).toContain("/Users/me/.codepilot/projects/abc/uploads/test.xlsx");
    expect(events[0]!.type === "message" && (events[0] as Extract<Event, { type: "message" }>).content[0]).toEqual({
      type: "text",
      text: "帮我分析一下该文件的平均薪资",
    });
  });
});
