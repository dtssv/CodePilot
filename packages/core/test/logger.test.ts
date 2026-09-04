import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  initLoggerFromConfig,
  getLoggerState,
  setLoggerState,
  rotateIfNeeded,
  defaultLogFilePath,
  clearLogsDir,
  __resetLoggerForTests,
  LOG_LEVELS,
} from "../src/logger.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createLogger", () => {
  beforeEach(() => {
    __resetLoggerForTests();
    // Make sure CODEPILOT_LOG_LEVEL is unset between tests.
    delete process.env.CODEPILOT_LOG_LEVEL;
  });

  it("exposes debug/info/warn/error methods", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("child() extends the namespace", () => {
    const log = createLogger("agent");
    const child = log.child!("session");
    expect(child).toBeDefined();
    // Smoke: don't crash.
    child.info("hi");
  });
});

describe("initLoggerFromConfig", () => {
  beforeEach(() => {
    __resetLoggerForTests();
    delete process.env.CODEPILOT_LOG_LEVEL;
  });

  it("respects config.level over env", () => {
    process.env.CODEPILOT_LOG_LEVEL = "debug";
    const dir = mkdtempSync(join(tmpdir(), "log-level-"));
    initLoggerFromConfig({ level: "error", file: join(dir, "x.log") });
    expect(getLoggerState().level).toBe("error");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to env when config has no level", () => {
    process.env.CODEPILOT_LOG_LEVEL = "debug";
    const dir = mkdtempSync(join(tmpdir(), "log-level-"));
    initLoggerFromConfig({ file: join(dir, "x.log") });
    expect(getLoggerState().level).toBe("debug");
    delete process.env.CODEPILOT_LOG_LEVEL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to 'info' when neither is set", () => {
    delete process.env.CODEPILOT_LOG_LEVEL;
    const dir = mkdtempSync(join(tmpdir(), "log-level-"));
    initLoggerFromConfig({ file: join(dir, "x.log") });
    expect(getLoggerState().level).toBe("info");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes NDJSON records to the configured file", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-write-"));
    const file = join(dir, "test.log");
    initLoggerFromConfig({ level: "debug", file, console: false });

    const log = createLogger("agent");
    log.info("hello", { foo: 1 });
    log.warn("careful", { bar: "x" });

    const text = readFileSync(file, "utf-8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].msg).toBe("hello");
    expect(lines[0].foo).toBe(1);
    expect(lines[0].ns).toBe("agent");
    expect(lines[0].levelName).toBe("info");
    expect(typeof lines[0].ts).toBe("string");
    expect(lines[1].levelName).toBe("warn");
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters records below the active level", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-level-filter-"));
    const file = join(dir, "test.log");
    initLoggerFromConfig({ level: "warn", file, console: false });
    const log = createLogger("agent");
    log.debug("nope");
    log.info("nope2");
    log.warn("yes");
    log.error("yes2");
    const text = readFileSync(file, "utf-8");
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).levelName).toBe("warn");
    expect(JSON.parse(lines[1]).levelName).toBe("error");
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the default daily log path under HOME", () => {
    const before = defaultLogFilePath(new Date("2025-01-15T12:00:00Z"));
    expect(before).toMatch(/codepilot-2025-01-15\.log$/);
  });
});

describe("rotateIfNeeded", () => {
  it("renames the active file to .1 when over the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-rotate-"));
    const file = join(dir, "active.log");
    writeFileSync(file, "x".repeat(200), "utf-8");
    rotateIfNeeded(file, 100, 3);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(true);
    const rotated = readFileSync(`${file}.1`, "utf-8");
    expect(rotated.length).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shifts generations and drops the oldest", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-rotate-"));
    const file = join(dir, "active.log");
    // Seed existing rotations: .1 and .2 and .3
    writeFileSync(`${file}.1`, "one", "utf-8");
    writeFileSync(`${file}.2`, "two", "utf-8");
    writeFileSync(`${file}.3`, "three", "utf-8");
    writeFileSync(file, "x".repeat(200), "utf-8");
    rotateIfNeeded(file, 100, 3);
    // Active renamed to .1
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf-8").startsWith("x")).toBe(true);
    // .1 -> .2, .2 -> .3
    expect(readFileSync(`${file}.2`, "utf-8")).toBe("one");
    expect(readFileSync(`${file}.3`, "utf-8")).toBe("two");
    // The old .3 is gone
    expect(existsSync(`${file}.4`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when file is under the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-rotate-"));
    const file = join(dir, "active.log");
    writeFileSync(file, "small", "utf-8");
    rotateIfNeeded(file, 1024, 3);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-rotate-"));
    const file = join(dir, "missing.log");
    rotateIfNeeded(file, 10, 3);
    expect(existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("file rotation end-to-end", () => {
  it("rotates after the active file grows past the threshold", () => {
    __resetLoggerForTests();
    delete process.env.CODEPILOT_LOG_LEVEL;
    const dir = mkdtempSync(join(tmpdir(), "log-e2e-"));
    const file = join(dir, "rolling.log");

    // Tiny threshold so we can hit it with a handful of writes.
    initLoggerFromConfig({
      level: "debug",
      file,
      console: false,
      rotateBytes: 1024,
      rotateKeep: 2,
    });
    const log = createLogger("agent");
    // Each line is ~250 bytes — a few writes will definitely cross 1 KB.
    for (let i = 0; i < 8; i++) {
      log.info("payload", { i, padding: "x".repeat(200) });
    }

    const names = readdirSync(dir).sort();
    // We expect at least the active file and one rotated generation.
    expect(names).toContain("rolling.log");
    expect(names.some((n) => n === "rolling.log.1")).toBe(true);
    // Rotated file should be non-empty.
    const rotatedSize = statSync(`${file}.1`).size;
    expect(rotatedSize).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("LOG_LEVELS", () => {
  it("orders levels correctly", () => {
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
  });
});
