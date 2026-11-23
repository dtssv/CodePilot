import { describe, expect, it } from "vitest";

import {
  CHAT_VIEW,
  chatViewIdFor,
  isPanelPosition,
} from "../src/panelPosition.js";

describe("panelPosition", () => {
  it("accepts the four dock sides", () => {
    expect(["left", "right", "top", "bottom"].every(isPanelPosition)).toBe(true);
    expect(isPanelPosition("center")).toBe(false);
  });

  it("maps dock side to the matching webview id", () => {
    expect(chatViewIdFor("left")).toBe(CHAT_VIEW.left);
    expect(chatViewIdFor("right")).toBe(CHAT_VIEW.right);
    expect(chatViewIdFor("top")).toBe(CHAT_VIEW.panel);
    expect(chatViewIdFor("bottom")).toBe(CHAT_VIEW.panel);
  });
});
