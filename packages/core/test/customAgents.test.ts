// Contract tests for custom sub-agent discovery (customAgents.ts).
//
// Covers the discovery sources (project / user / plugin extraDirs), the
// name-collision priority (project > user > plugin), and the fail-soft
// guarantee that one unreadable dir never aborts discovery — the invariant
// that keeps a bad installed plugin from breaking the agent roster.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverCustomAgents, parseAgentFile } from "../src/customAgents.js";

function writeAgent(dir: string, name: string, description = "an agent", body = "body"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

let tmp: string;
let projectDir: string;
let userDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codepilot-agents-"));
  projectDir = join(tmp, "project");
  userDir = join(tmp, "user");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseAgentFile", () => {
  it("parses required frontmatter and rejects malformed names", () => {
    const ok = parseAgentFile("---\nname: helper\ndescription: d\n---\nbody", "/p.md", "project");
    expect(ok?.name).toBe("helper");
    expect(ok?.source).toBe("project");
    // Missing description → null.
    expect(parseAgentFile("---\nname: helper\n---\nb", "/p.md", "user")).toBeNull();
    // Uppercase name → null (lowercase/hyphen only).
    expect(parseAgentFile("---\nname: Helper\ndescription: d\n---\nb", "/p.md", "plugin")).toBeNull();
  });
});

describe("discoverCustomAgents", () => {
  it("discovers project + user agents", async () => {
    writeAgent(join(projectDir, ".codepilot", "agents"), "proj-agent");
    writeAgent(join(userDir, ".codepilot", "agents"), "user-agent");
    const agents = await discoverCustomAgents(projectDir, {
      userDir: join(userDir, ".codepilot", "agents"),
    });
    expect(agents.get("proj-agent")?.source).toBe("project");
    expect(agents.get("user-agent")?.source).toBe("user");
  });

  it("merges plugin agents from extraDirs at LOWEST priority", async () => {
    const pluginDir = join(tmp, "plugin", "agents");
    // Plugin and project both define `shared`; project must win.
    writeAgent(pluginDir, "shared", "from plugin");
    writeAgent(pluginDir, "plugin-only", "unique to plugin");
    writeAgent(join(projectDir, ".codepilot", "agents"), "shared", "from project");
    const agents = await discoverCustomAgents(projectDir, {
      userDir: join(tmp, "no-user"),
      extraDirs: [pluginDir],
    });
    expect(agents.get("shared")?.source).toBe("project");
    expect(agents.get("shared")?.description).toBe("from project");
    expect(agents.get("plugin-only")?.source).toBe("plugin");
  });

  it("is fail-soft: an unreadable extraDir never aborts discovery", async () => {
    writeAgent(join(projectDir, ".codepilot", "agents"), "keep");
    const agents = await discoverCustomAgents(projectDir, {
      userDir: join(tmp, "no-user"),
      extraDirs: [join(tmp, "does-not-exist")],
    });
    expect(agents.has("keep")).toBe(true);
  });

  it("returns an empty map when no sources exist", async () => {
    const agents = await discoverCustomAgents(join(tmp, "nowhere"), {
      userDir: join(tmp, "no-user"),
    });
    expect(agents.size).toBe(0);
  });
});
