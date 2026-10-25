import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  shouldAttemptDailyUpdate,
  resetCatalogMemoryForTests,
} from "../src/remoteCatalog.js";

describe("shouldAttemptDailyUpdate", () => {
  it("attempts when there is no cache", () => {
    expect(shouldAttemptDailyUpdate(null)).toBe(true);
  });

  it("skips when last attempt was today", () => {
    const now = Date.now();
    expect(shouldAttemptDailyUpdate({ fetchedAt: now, lastAttemptAt: now })).toBe(false);
  });

  it("attempts when last attempt was yesterday", () => {
    const yesterday = Date.now() - 36 * 60 * 60 * 1000;
    expect(
      shouldAttemptDailyUpdate({ fetchedAt: yesterday, lastAttemptAt: yesterday }),
    ).toBe(true);
  });

  it("keeps serving old data semantics: failed day still has cache", () => {
    // Documented contract: even if we would attempt again tomorrow, today's
    // failed attempt leaves fetchedAt/data untouched — only lastAttemptAt moves.
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const today = Date.now();
    expect(shouldAttemptDailyUpdate({ fetchedAt: old, lastAttemptAt: today })).toBe(false);
  });
});

describe("resetCatalogMemoryForTests", () => {
  beforeEach(() => resetCatalogMemoryForTests());
  afterEach(() => resetCatalogMemoryForTests());

  it("clears memory without throwing", () => {
    resetCatalogMemoryForTests();
    expect(true).toBe(true);
  });
});

// Smoke: listConnectors / listProviderTemplates use bundled catalog offline.
describe("catalog list (bundled)", () => {
  it("lists connectors from bundled JSON", async () => {
    const { listConnectors } = await import("../src/connectors.js");
    const list = await listConnectors();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((c) => c.id === "feishu")).toBe(true);
  });

  it("lists provider templates from bundled JSON", async () => {
    const { listProviderTemplates } = await import("../src/providerCatalog.js");
    const list = await listProviderTemplates();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((t) => t.id === "deepseek")).toBe(true);
  });
});
