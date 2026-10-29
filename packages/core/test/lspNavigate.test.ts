import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  LspManager,
  languageIdForPath,
  parseLocations,
  DEFAULT_LSP_SERVERS,
} from "../src/lsp.js";

describe("languageIdForPath", () => {
  it("maps TypeScript/JavaScript extensions", () => {
    expect(languageIdForPath("a/b/foo.ts")).toBe("typescript");
    expect(languageIdForPath("foo.mts")).toBe("typescript");
    expect(languageIdForPath("foo.cts")).toBe("typescript");
    expect(languageIdForPath("foo.tsx")).toBe("typescriptreact");
    expect(languageIdForPath("foo.js")).toBe("javascript");
    expect(languageIdForPath("foo.mjs")).toBe("javascript");
    expect(languageIdForPath("foo.cjs")).toBe("javascript");
    expect(languageIdForPath("foo.jsx")).toBe("javascriptreact");
  });

  it("maps a few other languages and is case-insensitive", () => {
    expect(languageIdForPath("foo.PY")).toBe("python");
    expect(languageIdForPath("foo.go")).toBe("go");
    expect(languageIdForPath("foo.rs")).toBe("rust");
  });

  it("returns null for unknown or extensionless paths", () => {
    expect(languageIdForPath("foo.txt")).toBeNull();
    expect(languageIdForPath("Makefile")).toBeNull();
    expect(languageIdForPath("foo")).toBeNull();
  });
});

describe("parseLocations", () => {
  it("returns [] for empty/null results", () => {
    expect(parseLocations(null)).toEqual([]);
    expect(parseLocations(undefined)).toEqual([]);
    expect(parseLocations([])).toEqual([]);
  });

  it("converts a single Location to a 1-based location", () => {
    const loc = {
      uri: "file:///tmp/foo.ts",
      range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
    };
    expect(parseLocations(loc)).toEqual([{ path: "/tmp/foo.ts", line: 5, column: 3 }]);
  });

  it("handles an array of Locations and LocationLinks", () => {
    const results = [
      { uri: "file:///tmp/a.ts", range: { start: { line: 0, character: 0 } } },
      { targetUri: "file:///tmp/b.ts", targetRange: { start: { line: 9, character: 4 } } },
    ];
    expect(parseLocations(results)).toEqual([
      { path: "/tmp/a.ts", line: 1, column: 1 },
      { path: "/tmp/b.ts", line: 10, column: 5 },
    ]);
  });

  it("skips entries without a uri or range", () => {
    const results = [
      { uri: "file:///tmp/a.ts" }, // no range
      { range: { start: { line: 0, character: 0 } } }, // no uri
      null,
      "garbage",
      { uri: "file:///tmp/c.ts", range: { start: { line: 1, character: 1 } } },
    ];
    expect(parseLocations(results)).toEqual([{ path: "/tmp/c.ts", line: 2, column: 2 }]);
  });

  it("keeps non-file URIs verbatim when they cannot be converted to a path", () => {
    const loc = { uri: "untitled:Untitled-1", range: { start: { line: 0, character: 0 } } };
    expect(parseLocations(loc)).toEqual([
      { path: "untitled:Untitled-1", line: 1, column: 1 },
    ]);
  });
});

describe("LspManager (no server configured)", () => {
  it("reports a clear reason for an unsupported file type", async () => {
    const mgr = new LspManager();
    const r = await mgr.navigate("definition", "/tmp", "/tmp/notes.txt", {
      line: 0,
      character: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no LSP server configured/i);
    await mgr.stopAll();
  });

  it("matches the built-in TS/JS default by language id", () => {
    const mgr = new LspManager();
    const match = mgr.configFor("/tmp/foo.ts");
    expect(match?.languageId).toBe("typescript");
    expect(match?.config.command).toBe(DEFAULT_LSP_SERVERS[0]!.command);
  });

  it("returns null config for an unsupported file", () => {
    const mgr = new LspManager();
    expect(mgr.configFor("/tmp/foo.txt")).toBeNull();
  });
});

// End-to-end against a real TypeScript language server. The binary isn't a
// direct dependency and isn't on PATH, but npm caches it under the user's real
// home after any `npx typescript-language-server` run. The test harness
// (test/setup.ts) redirects HOME to a temp dir, which hides npx's own cache, so
// instead of going through npx we locate the cached `cli.mjs` directly and
// spawn it with `node`. When no cached copy exists (e.g. clean CI), the e2e
// cases skip so the suite stays green.
function findTsServerCli(): string | null {
  // Use the OS account's real home (userInfo reads the password db and ignores
  // the test harness's HOME override) so we see npm's real npx cache.
  const home = userInfo().homedir || homedir();
  const npxRoot = join(home, ".npm", "_npx");
  let dirs: string[];
  try {
    dirs = readdirSync(npxRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const cli = join(npxRoot, d, "node_modules", "typescript-language-server", "lib", "cli.mjs");
    if (existsSync(cli)) return cli;
  }
  return null;
}

const tsServerCli = findTsServerCli();

// The repo's own TypeScript, used to pin tsserver for the (empty) temp
// workspace. createRequire resolves it from this test module.
const repoTsserver = (() => {
  try {
    const req = createRequire(import.meta.url);
    const main = req.resolve("typescript"); // .../typescript/lib/typescript.js
    return join(dirname(main), "tsserver.js");
  } catch {
    return null;
  }
})();

let tsServerWorks = false;
if (tsServerCli) {
  // Confirm the cached server actually starts (it needs a resolvable tsserver).
  const probe = spawnSync(process.execPath, [tsServerCli, "--version"], {
    encoding: "utf-8",
    timeout: 20_000,
  });
  tsServerWorks = probe.status === 0;
}
const hasTsServer = tsServerWorks;

/** Server config that spawns the cached cli.mjs directly via node. Pins the
 * repo's own TypeScript so the server resolves tsserver regardless of the
 * (empty) temp workspace. */
function tsServerConfig(languages: string[]) {
  return {
    command: process.execPath,
    args: [tsServerCli!, "--stdio"],
    languages,
    initializationOptions: repoTsserver ? { tsserver: { path: repoTsserver } } : undefined,
  };
}

describe("LspManager e2e (typescript-language-server)", () => {
  let root: string | null = null;
  let mgr: LspManager | null = null;

  afterEach(async () => {
    await mgr?.stopAll();
    mgr = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it.skipIf(!hasTsServer)(
    "resolves go-to-definition to a declaration in the same file",
    async () => {
      root = mkdtempSync(join(tmpdir(), "lsp-e2e-"));
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const filePath = join(root, "main.ts");
      // `greet` declared on line 1, called on line 3.
      writeFileSync(
        filePath,
        "function greet(name: string) {\n  return `hi ${name}`;\n}\nconst msg = greet(\"world\");\nconsole.log(msg);\n",
      );

      mgr = new LspManager([
        tsServerConfig(["typescript", "typescriptreact", "javascript", "javascriptreact"]),
      ]);

      // 0-based: line 4 (`const msg = greet(...)`), `greet` starts at column 12.
      const r = await mgr.navigate("definition", root, filePath, { line: 3, character: 13 });
      expect(r.ok, r.ok ? "" : (r as { reason: string }).reason).toBe(true);
      if (!r.ok) return;
      const locs = parseLocations(r.result);
      expect(locs.length).toBeGreaterThanOrEqual(1);
      // Go-to-definition should land on the declaration (line 1).
      const def = locs.find((l) => l.path === filePath && l.line === 1);
      expect(def, `expected a definition on line 1; got ${JSON.stringify(locs)}`).toBeDefined();
    },
    30_000,
  );

  it.skipIf(!hasTsServer)(
    "returns hover type info at a symbol",
    async () => {
      root = mkdtempSync(join(tmpdir(), "lsp-e2e-"));
      const filePath = join(root, "hov.ts");
      writeFileSync(filePath, "const answer = 42;\nconsole.log(answer);\n");

      mgr = new LspManager([tsServerConfig(["typescript"])]);

      // Hover over `answer` in its declaration (line 1, the identifier).
      const r = await mgr.navigate("hover", root, filePath, { line: 0, character: 6 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const hover = r.result as { contents?: unknown };
      const text = JSON.stringify(hover.contents ?? "");
      expect(text).toMatch(/answer/);
    },
    30_000,
  );
});
