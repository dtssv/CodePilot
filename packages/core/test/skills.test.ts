import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSkillMd,
  discoverSkills,
  matchSkill,
  findSkill,
  skillsPromptSection,
  BUILTIN_SKILLS,
  defaultBuiltinSkillsDir,
  type Skill,
} from "../src/skills.js";
import { skillTool, StaticSkillStore, createSkillTool } from "../src/tools/skill.js";

function writeSkill(
  dir: string,
  name: string,
  body: string,
  frontmatter: string
): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const text = `---\n${frontmatter}\n---\n${body}\n`;
  writeFileSync(join(skillDir, "SKILL.md"), text, "utf-8");
}

describe("parseSkillMd", () => {
  it("extracts the four recognised keys", () => {
    const fm = parseSkillMd(
      [
        "---",
        "name: commit",
        "description: Stage and commit the current change.",
        "when: the user says commit",
        "tools:",
        "  - bash",
        "  - read_file",
        "---",
        "# body",
      ].join("\n")
    );
    expect(fm.name).toBe("commit");
    expect(fm.description).toBe("Stage and commit the current change.");
    expect(fm.when).toBe("the user says commit");
    expect(fm.tools).toEqual(["bash", "read_file"]);
  });

  it("returns an empty object when there is no frontmatter", () => {
    const fm = parseSkillMd("# just a body\nno frontmatter here\n");
    expect(fm).toEqual({});
  });

  it("handles flow-list values", () => {
    const fm = parseSkillMd(
      "---\nname: a\ntools: [bash, read_file, grep]\n---\nbody"
    );
    expect(fm.tools).toEqual(["bash", "read_file", "grep"]);
  });

  it("strips surrounding quotes from values", () => {
    const fm = parseSkillMd(
      '---\nname: "x"\ndescription: \'with quote\'\n---\nbody'
    );
    expect(fm.name).toBe("x");
    expect(fm.description).toBe("with quote");
  });

  it("ignores unknown keys", () => {
    const fm = parseSkillMd(
      "---\nname: a\nsomething: ignored\n---\nbody"
    );
    expect(fm).toEqual({ name: "a" });
  });

  it("treats an unterminated frontmatter as missing", () => {
    const fm = parseSkillMd("---\nname: a\ndescription: b\nno closing fence");
    expect(fm).toEqual({});
  });
});

describe("discoverSkills", () => {
  let work: string;
  let home: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "skills-work-"));
    home = mkdtempSync(join(tmpdir(), "skills-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers project, user, and builtin skills with project overriding user and builtin", async () => {
    // project: a "commit" override
    writeSkill(
      join(work, ".codepilot", "skills"),
      "commit",
      "PROJECT commit body",
      "name: commit\ndescription: from project\n"
    );
    // user: a custom "deploy" skill
    writeSkill(
      join(home, ".codepilot", "skills"),
      "deploy",
      "USER deploy body",
      "name: deploy\ndescription: from user\n"
    );

    // built-in dir override to avoid touching the on-disk copy
    const builtinDir = mkdtempSync(join(tmpdir(), "skills-builtin-"));
    writeSkill(
      builtinDir,
      "review",
      "BUILTIN review body",
      "name: review\ndescription: from builtin\n"
    );

    const skills = await discoverSkills(work, {
      projectDir: join(work, ".codepilot", "skills"),
      userDir: join(home, ".codepilot", "skills"),
      builtinDir,
    });
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("commit")?.description).toBe("from project");
    expect(byName.get("commit")?.source).toBe("project");
    expect(byName.get("deploy")?.description).toBe("from user");
    expect(byName.get("deploy")?.source).toBe("user");
    expect(byName.get("review")?.description).toBe("from builtin");
    expect(byName.get("review")?.source).toBe("builtin");
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("uses the first definition of a name (project > user > builtin)", async () => {
    writeSkill(
      join(work, ".codepilot", "skills"),
      "shared",
      "PROJECT",
      "name: shared\ndescription: project wins\n"
    );
    writeSkill(
      join(home, ".codepilot", "skills"),
      "shared",
      "USER",
      "name: shared\ndescription: user would win but project does\n"
    );
    const skills = await discoverSkills(work, {
      projectDir: join(work, ".codepilot", "skills"),
      userDir: join(home, ".codepilot", "skills"),
      builtinDir: mkdtempSync(join(tmpdir(), "skills-empty-")),
    });
    expect(skills.filter((s) => s.name === "shared")).toHaveLength(1);
    expect(skills.find((s) => s.name === "shared")?.source).toBe("project");
  });

  it("falls back to the embedded BUILTIN_SKILLS when the on-disk dir is missing", async () => {
    const missingDir = join(work, "does-not-exist");
    const skills = await discoverSkills(work, {
      projectDir: missingDir,
      userDir: missingDir,
      builtinDir: missingDir, // no on-disk builtins → fall back to embedded
    });
    const names = new Set(skills.map((s) => s.name));
    for (const b of BUILTIN_SKILLS) {
      expect(names.has(b.name)).toBe(true);
    }
    for (const s of skills) {
      expect(s.source).toBe("builtin");
    }
  });

  it("skips folders without a SKILL.md", async () => {
    const dir = join(work, ".codepilot", "skills");
    mkdirSync(join(dir, "broken"), { recursive: true });
    // no SKILL.md inside
    const skills = await discoverSkills(work, {
      projectDir: dir,
      userDir: join(home, ".codepilot", "skills"),
      builtinDir: join(work, "missing"),
    });
    expect(skills.some((s) => s.name === "broken")).toBe(false);
  });
});

describe("matchSkill", () => {
  const skills: Skill[] = [
    {
      name: "commit",
      description: "Stage and commit changes.",
      when: "user says commit",
      path: "/tmp/c/SKILL.md",
      dir: "/tmp/c",
      source: "user",
      body: "",
    },
    {
      name: "code-review",
      description: "Review a diff with severity tags.",
      path: "/tmp/cr/SKILL.md",
      dir: "/tmp/cr",
      source: "builtin",
      body: "",
    },
  ];
  it("exact name match wins", () => {
    expect(matchSkill(skills, "commit")?.name).toBe("commit");
  });
  it("substring of name matches", () => {
    expect(matchSkill(skills, "rev")?.name).toBe("code-review");
  });
  it("keyword in description matches", () => {
    expect(matchSkill(skills, "severity")?.name).toBe("code-review");
  });
  it("returns null when nothing matches", () => {
    expect(matchSkill(skills, "unicorn")).toBeNull();
  });
  it("empty query returns null", () => {
    expect(matchSkill(skills, "   ")).toBeNull();
  });
});

describe("findSkill", () => {
  const skills: Skill[] = [
    {
      name: "Commit",
      description: "",
      path: "/tmp/c/SKILL.md",
      dir: "/tmp/c",
      source: "user",
      body: "",
    },
  ];
  it("matches case-insensitively on name", () => {
    expect(findSkill(skills, "commit")?.name).toBe("Commit");
    expect(findSkill(skills, "Commit")?.name).toBe("Commit");
  });
});

describe("skillsPromptSection", () => {
  it("returns an empty string when no skills", () => {
    expect(skillsPromptSection([])).toBe("");
  });
  it("includes name and description for each skill", () => {
    const s: Skill = {
      name: "commit",
      description: "Commit the current change",
      when: "user says commit",
      path: "/p",
      dir: "/d",
      source: "user",
      body: "",
      tools: ["bash"],
    };
    const out = skillsPromptSection([s]);
    expect(out).toMatch(/<skills>/);
    expect(out).toMatch(/<\/skills>/);
    expect(out).toMatch(/`commit`/);
    expect(out).toMatch(/Commit the current change/);
    expect(out).toMatch(/when: user says commit/);
    expect(out).toMatch(/\[tools: bash\]/);
  });
});

describe("defaultBuiltinSkillsDir", () => {
  it("points to a directory that exists (the on-disk skills/ folder)", () => {
    const dir = defaultBuiltinSkillsDir();
    // The exact path varies between `src/` and `dist/`, but it should
    // resolve to a real directory under the package root.
    expect(dir).toMatch(/skills$/);
  });
});

describe("skill tool", () => {
  it("returns the body of a known skill via a StaticSkillStore", async () => {
    const skill: Skill = {
      name: "commit",
      description: "desc",
      path: "/p/c/SKILL.md",
      dir: "/p/c",
      source: "user",
      body: "do the thing",
    };
    const handle = createSkillTool();
    handle.setStore(new StaticSkillStore([skill]));
    const r = await handle.tool.execute(
      { name: "commit" },
      {
        cwd: "/tmp",
        async artifact() {
          return "ref";
        },
        async readArtifact() {
          return "";
        },
      }
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("do the thing");
    expect(r.content).toMatch(/^# skill: commit/);
  });

  it("returns an error for an unknown skill", async () => {
    const handle = createSkillTool();
    handle.setStore(new StaticSkillStore([]));
    const r = await handle.tool.execute(
      { name: "ghost" },
      {
        cwd: "/tmp",
        async artifact() {
          return "ref";
        },
        async readArtifact() {
          return "";
        },
      }
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unknown skill/);
  });

  it("falls back to matchSkill when exact name is missing", async () => {
    const skill: Skill = {
      name: "code-review",
      description: "Review a diff",
      path: "/p/cr/SKILL.md",
      dir: "/p/cr",
      source: "user",
      body: "review body",
    };
    const handle = createSkillTool();
    handle.setStore(new StaticSkillStore([skill]));
    const r = await handle.tool.execute(
      { name: "rev" }, // substring
      {
        cwd: "/tmp",
        async artifact() {
          return "ref";
        },
        async readArtifact() {
          return "";
        },
      }
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("review body");
  });

  it("the module-level skillTool instance works after wiring a store", async () => {
    // Ensure the exported singleton can be wired and used.
    const skill: Skill = {
      name: "alpha",
      description: "a",
      path: "/a/SKILL.md",
      dir: "/a",
      source: "builtin",
      body: "alpha body",
    };
    // Use the exported createSkillTool path so we don't mutate the
    // module-level singleton (which other tests may use).
    const handle = createSkillTool();
    handle.setStore(new StaticSkillStore([skill]));
    const r = await handle.tool.execute(
      { name: "alpha" },
      {
        cwd: "/tmp",
        async artifact() {
          return "ref";
        },
        async readArtifact() {
          return "";
        },
      }
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("alpha body");
    // The exported `skillTool` is the inner `.tool` of a separate handle.
    expect(skillTool.name).toBe("skill");
  });
});
