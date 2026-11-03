// Skill management (Settings plumbing): enable/disable, save SKILL.md,
// copy-on-write of a builtin, the path-traversal guard, and archive install.
// These paths do real filesystem + archive work with a security-sensitive
// path guard, so they get regression locks here (skillManage.ts had none).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  setSkillEnabled,
  saveSkillContent,
  saveSkillFile,
  getSkillContent,
  installSkillFromArchive,
  installSkillFromSource,
} from "../src/skillManage.js";
import { getUserConfigPath } from "../src/config.js";

// getUserConfigPath()/defaultSkillsDir() are home-anchored; HOME is a temp dir
// (test/setup.ts). Snapshot + restore the shared user config so enable/disable
// here does not leak into other tests that read `skills.disabled`.
const userCfg = getUserConfigPath();
let cfgBackup: string | null = null;
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cp-skmgmt-"));
  cfgBackup = existsSync(userCfg) ? readFileSync(userCfg, "utf-8") : null;
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  if (cfgBackup === null) {
    if (existsSync(userCfg)) rmSync(userCfg, { force: true });
  } else {
    writeFileSync(userCfg, cfgBackup, "utf-8");
  }
  // Clean any user skills this test copied/installed into the temp HOME.
  const userSkills = join(homedir(), ".codepilot", "skills");
  rmSync(userSkills, { recursive: true, force: true });
});

function writeProjectSkill(name: string, frontmatter: string, body = "do the thing"): string {
  const dir = join(cwd, ".codepilot", "skills", name);
  mkdirSync(dir, { recursive: true });
  const text = `---\n${frontmatter}\n---\n\n${body}\n`;
  writeFileSync(join(dir, "SKILL.md"), text, "utf-8");
  return join(dir, "SKILL.md");
}

describe("setSkillEnabled", () => {
  it("adds and removes a name from skills.disabled in the user config", async () => {
    const off = await setSkillEnabled("review", false);
    expect(off.enabled).toBe(false);
    const cfg1 = JSON.parse(await readFile(userCfg, "utf-8")) as { skills?: { disabled?: string[] } };
    expect(cfg1.skills?.disabled).toContain("review");

    const on = await setSkillEnabled("review", true);
    expect(on.enabled).toBe(true);
    const cfg2 = JSON.parse(await readFile(userCfg, "utf-8")) as { skills?: { disabled?: string[] } };
    expect(cfg2.skills?.disabled ?? []).not.toContain("review");
  });

  it("rejects an empty name", async () => {
    await expect(setSkillEnabled("  ", false)).rejects.toThrow();
  });
});

describe("saveSkillContent (user/project)", () => {
  it("saves SKILL.md in place for a project skill", async () => {
    writeProjectSkill("mine", "name: mine\ndescription: original");
    const updated = `---\nname: mine\ndescription: changed\n---\n\nnew body\n`;
    const res = await saveSkillContent("mine", updated, cwd);
    expect(existsSync(res.path)).toBe(true);
    const back = await getSkillContent("mine", cwd);
    expect(back.markdown).toContain("description: changed");
    expect(back.source).toBe("project");
  });

  it("rejects a SKILL.md without frontmatter", async () => {
    writeProjectSkill("nofm", "name: nofm\ndescription: d");
    await expect(saveSkillContent("nofm", "no frontmatter here", cwd)).rejects.toThrow(/frontmatter/);
  });

  it("rejects empty content", async () => {
    writeProjectSkill("empty", "name: empty\ndescription: d");
    await expect(saveSkillContent("empty", "   ", cwd)).rejects.toThrow();
  });
});

describe("saveSkillFile copy-on-write of a builtin", () => {
  it("copies a builtin to the user dir before editing, leaving the builtin intact", async () => {
    // `commit` is a shipped builtin; editing it must not mutate the builtin —
    // it is copied to ~/.codepilot/skills/commit first (user copy wins).
    const before = await getSkillContent("commit", cwd);
    expect(before.readOnlySource).toBe(true);
    expect(before.source).toBe("builtin");

    const res = await saveSkillFile(
      "commit",
      "SKILL.md",
      "---\nname: commit\ndescription: my override\n---\n\nmy workflow\n",
      cwd,
    );
    // The written file lives under the user skills dir, not the builtin dir.
    expect(res.path).toContain(join(homedir(), ".codepilot", "skills", "commit"));
    // Re-reading now resolves to the user copy.
    const after = await getSkillContent("commit", cwd);
    expect(after.source).toBe("user");
    expect(after.markdown).toContain("my override");
  });
});

describe("path-traversal guard (saveSkillFile)", () => {
  it("rejects a relative path that escapes the skill root", async () => {
    writeProjectSkill("guard", "name: guard\ndescription: d");
    await expect(
      saveSkillFile("guard", "../../evil.md", "x", cwd),
    ).rejects.toThrow(/非法技能文件路径/);
    // The escape target must NOT have been written.
    expect(existsSync(join(cwd, ".codepilot", "skills", "evil.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codepilot", "evil.md"))).toBe(false);
  });

  it("allows a companion file inside the skill root", async () => {
    writeProjectSkill("withtpl", "name: withtpl\ndescription: d");
    const res = await saveSkillFile("withtpl", "templates/msg.md", "hello\n", cwd);
    expect(existsSync(res.path)).toBe(true);
    expect(res.path).toContain(join("withtpl", "templates", "msg.md"));
  });
});

describe("installSkillFromArchive", () => {
  it("installs a skill from a .zip containing SKILL.md", async () => {
    // Build a tiny zip with a skill folder. Skip if `zip` is unavailable.
    let zipOk = true;
    const staging = join(cwd, "pkg", "my-zip-skill");
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, "SKILL.md"),
      "---\nname: my-zip-skill\ndescription: from a zip\n---\n\nzip body\n",
      "utf-8",
    );
    const zipPath = join(cwd, "skill.zip");
    try {
      execFileSync("zip", ["-r", "-q", zipPath, "my-zip-skill"], { cwd: join(cwd, "pkg") });
    } catch {
      zipOk = false;
    }
    if (!zipOk) return; // `zip` not installed in this environment

    const skillsDir = join(cwd, "installed-skills");
    const res = await installSkillFromArchive(
      { filename: "skill.zip", dataBase64: readFileSync(zipPath).toString("base64") },
      { skillsDir },
    );
    expect(res.names).toContain("my-zip-skill");
    expect(existsSync(join(skillsDir, "my-zip-skill", "SKILL.md"))).toBe(true);
  });

  it("rejects an unsupported archive extension", async () => {
    await expect(
      installSkillFromArchive({ filename: "skill.rar", dataBase64: "AAAA" }),
    ).rejects.toThrow(/zip|tar|7z/);
  });

  it("rejects an empty payload", async () => {
    await expect(
      installSkillFromArchive({ filename: "skill.zip", dataBase64: "" }),
    ).rejects.toThrow();
  });
});

describe("installSkillFromSource", () => {
  it("installs from a local directory tree", async () => {
    // A plain folder containing SKILL.md is a valid source (mirrors the
    // local-dir branch of installPlugin).
    const srcDir = join(cwd, "src-skill");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "SKILL.md"),
      "---\nname: local-dir-skill\ndescription: from a local dir\n---\n\nbody\n",
      "utf-8",
    );
    writeFileSync(join(srcDir, "template.md"), "companion\n", "utf-8");

    const skillsDir = join(cwd, "installed");
    const res = await installSkillFromSource(srcDir, { skillsDir });
    expect(res.names).toContain("local-dir-skill");
    // Companion files come along with the folder copy.
    expect(existsSync(join(skillsDir, "local-dir-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "local-dir-skill", "template.md"))).toBe(true);
  });

  it("installs from a local .zip archive path", async () => {
    let zipOk = true;
    const staging = join(cwd, "pkg2", "zip-src-skill");
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, "SKILL.md"),
      "---\nname: zip-src-skill\ndescription: from a local zip path\n---\n\nbody\n",
      "utf-8",
    );
    const zipPath = join(cwd, "src.zip");
    try {
      execFileSync("zip", ["-r", "-q", zipPath, "zip-src-skill"], { cwd: join(cwd, "pkg2") });
    } catch {
      zipOk = false;
    }
    if (!zipOk) return;

    const skillsDir = join(cwd, "installed2");
    const res = await installSkillFromSource(zipPath, { skillsDir });
    expect(res.names).toContain("zip-src-skill");
    expect(existsSync(join(skillsDir, "zip-src-skill", "SKILL.md"))).toBe(true);
  });

  it("installs from a remote archive URL (download then extract)", async () => {
    // Build a real .tar.gz on disk, then stub fetch to return its bytes so the
    // remote-archive branch is exercised end to end without network.
    let tarOk = true;
    const staging = join(cwd, "pkg3", "remote-tgz-skill");
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, "SKILL.md"),
      "---\nname: remote-tgz-skill\ndescription: from a remote tgz\n---\n\nbody\n",
      "utf-8",
    );
    const tgzPath = join(cwd, "remote.tgz");
    try {
      execFileSync("tar", ["-czf", tgzPath, "remote-tgz-skill"], { cwd: join(cwd, "pkg3") });
    } catch {
      tarOk = false;
    }
    if (!tarOk) return;

    const { vi } = await import("vitest");
    const bytes = readFileSync(tgzPath);
    vi.stubGlobal("fetch", async (url: unknown) => {
      expect(String(url)).toBe("https://example.com/pack.tgz");
      return new Response(new Uint8Array(bytes), { status: 200 });
    });

    const skillsDir = join(cwd, "installed3");
    const res = await installSkillFromSource("https://example.com/pack.tgz", { skillsDir });
    expect(res.names).toContain("remote-tgz-skill");
    expect(existsSync(join(skillsDir, "remote-tgz-skill", "SKILL.md"))).toBe(true);

    vi.restoreAllMocks();
  });

  it("surfaces a failed remote download", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404, statusText: "Not Found" }));
    await expect(
      installSkillFromSource("https://example.com/pack.zip", { skillsDir: join(cwd, "x") }),
    ).rejects.toThrow(/404|下载失败/);
    vi.restoreAllMocks();
  });

  it("rejects an empty source", async () => {
    await expect(installSkillFromSource("   ")).rejects.toThrow();
  });

  it("rejects a local source that does not exist", async () => {
    await expect(
      installSkillFromSource(join(cwd, "no-such-dir"), { skillsDir: join(cwd, "y") }),
    ).rejects.toThrow(/不存在|not/);
  });

  it("errors when the source has no SKILL.md", async () => {
    const empty = join(cwd, "empty-src");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "README.md"), "not a skill\n", "utf-8");
    await expect(
      installSkillFromSource(empty, { skillsDir: join(cwd, "z") }),
    ).rejects.toThrow(/SKILL\.md/);
  });
});
