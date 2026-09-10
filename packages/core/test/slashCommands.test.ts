import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSlashCommandMd,
  discoverSlashCommands,
  findSlashCommand,
  commandHelpLine,
  renderCommandPrompt,
  interpolateTemplate,
  isValidCommandName,
  resolveSlashCommand,
  resolveCommandsDir,
  commandsDirFor,
  userCommandsDir,
  commandFilePath,
  commandDir,
  type SlashCommand,
} from "../src/slashCommands.js";

function writeCommand(
  dir: string,
  name: string,
  body: string,
  frontmatter = ""
): string {
  mkdirSync(dir, { recursive: true });
  const text = frontmatter.length > 0 ? `---\n${frontmatter}\n---\n${body}\n` : `${body}\n`;
  const path = commandFilePath(dir, name);
  writeFileSync(path, text, "utf-8");
  return path;
}

let tmp: string;
let projectDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codepilot-cmd-"));
  projectDir = join(tmp, "project");
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseSlashCommandMd
// ---------------------------------------------------------------------------

describe("parseSlashCommandMd", () => {
  it("extracts all four recognised keys", () => {
    const fm = parseSlashCommandMd(
      [
        "---",
        "description: Review a pull request.",
        'argument-hint: <PR number or URL>',
        "allowed-tools: [bash, read_file, grep]",
        "model: claude-sonnet-4-5",
        "---",
        "body",
      ].join("\n")
    );
    expect(fm.description).toBe("Review a pull request.");
    expect(fm.argumentHint).toBe("<PR number or URL>");
    expect(fm.allowedTools).toEqual(["bash", "read_file", "grep"]);
    expect(fm.model).toBe("claude-sonnet-4-5");
  });

  it("handles YAML-list form for allowed-tools", () => {
    const fm = parseSlashCommandMd(
      ["---", "allowed-tools:", "  - bash", "  - read_file", "---", "body"].join("\n")
    );
    expect(fm.allowedTools).toEqual(["bash", "read_file"]);
  });

  it("handles comma/space-separated bare string for allowed-tools (claude-code form)", () => {
    const fm = parseSlashCommandMd('---\nallowed-tools: Bash Read Grep\n---\nbody');
    expect(fm.allowedTools).toEqual(["Bash", "Read", "Grep"]);
  });

  it("returns an empty object when there is no frontmatter", () => {
    const fm = parseSlashCommandMd("# just a body\nno frontmatter here\n");
    expect(fm).toEqual({});
  });

  it("ignores unrecognised keys", () => {
    const fm = parseSlashCommandMd('---\nname: foo\nunknown-key: bar\n---\nbody');
    expect(fm.description).toBeUndefined();
    expect(fm.model).toBeUndefined();
  });

  it("strips quotes from values", () => {
    const fm = parseSlashCommandMd(
      '---\ndescription: "quoted desc"\nmodel: \'single-quoted\'\n---\nbody'
    );
    expect(fm.description).toBe("quoted desc");
    expect(fm.model).toBe("single-quoted");
  });
});

// ---------------------------------------------------------------------------
// isValidCommandName
// ---------------------------------------------------------------------------

describe("isValidCommandName", () => {
  it("accepts lowercase kebab/snake names", () => {
    expect(isValidCommandName("review")).toBe(true);
    expect(isValidCommandName("review-pr")).toBe(true);
    expect(isValidCommandName("my_command")).toBe(true);
    expect(isValidCommandName("a1")).toBe(true);
  });

  it("rejects uppercase, spaces, dots, and leading dash", () => {
    expect(isValidCommandName("Review")).toBe(false);
    expect(isValidCommandName("review pr")).toBe(false);
    expect(isValidCommandName("review.pr")).toBe(false);
    expect(isValidCommandName("-leading")).toBe(false);
    expect(isValidCommandName("")).toBe(false);
  });

  it("rejects names longer than 64 chars", () => {
    expect(isValidCommandName("a".repeat(64))).toBe(true);
    expect(isValidCommandName("a".repeat(65))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverSlashCommands
// ---------------------------------------------------------------------------

describe("discoverSlashCommands", () => {
  it("discovers project-local .md files", async () => {
    writeCommand(commandsDirFor(projectDir), "review", "Review the PR $1");
    const { commands, warnings } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "no-user-cmds"),
    });
    expect(warnings).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("review");
    expect(commands[0]!.source).toBe("project");
    expect(commands[0]!.body).toContain("Review the PR");
  });

  it("discovers from user-global dir too", async () => {
    const userDir = join(tmp, "user-cmds");
    writeCommand(userDir, "deploy", "Deploy $ARGUMENTS");
    const { commands } = await discoverSlashCommands(projectDir, { userDir });
    expect(commands.find((c) => c.name === "deploy")).toBeDefined();
    expect(commands.find((c) => c.name === "deploy")!.source).toBe("user");
  });

  it("project-local wins over user-global on name collision (first-definition-wins)", async () => {
    const userDir = join(tmp, "user-cmds");
    writeCommand(userDir, "review", "user version");
    writeCommand(commandsDirFor(projectDir), "review", "project version");
    const { commands } = await discoverSlashCommands(projectDir, { userDir });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.source).toBe("project");
    expect(commands[0]!.body).toContain("project version");
  });

  it("skips reserved names and surfaces a warning", async () => {
    writeCommand(commandsDirFor(projectDir), "model", "should be skipped");
    writeCommand(commandsDirFor(projectDir), "review", "ok");
    const { commands, warnings } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
      reservedNames: new Set(["model", "help"]),
    });
    expect(commands.map((c) => c.name)).toEqual(["review"]);
    expect(warnings.some((w) => w.includes("reserved"))).toBe(true);
  });

  it("skips invalid names with a warning", async () => {
    writeCommand(commandsDirFor(projectDir), "Bad-Name", "uppercase first char");
    writeCommand(commandsDirFor(projectDir), "good", "ok");
    const { commands, warnings } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    expect(commands.map((c) => c.name)).toEqual(["good"]);
    expect(warnings.some((w) => w.includes("Skipping"))).toBe(true);
  });

  it("skips non-.md files and dotfiles", async () => {
    const dir = commandsDirFor(projectDir);
    writeCommand(dir, "review", "ok");
    writeFileSync(join(dir, "README.txt"), "nope");
    writeFileSync(join(dir, ".hidden.md"), "nope");
    const { commands } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    expect(commands.map((c) => c.name)).toEqual(["review"]);
  });

  it("accepts hyphenated lowercase names from the filename", async () => {
    writeCommand(commandsDirFor(projectDir), "review-pr", "body");
    const { commands } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    expect(commands[0]!.name).toBe("review-pr");
  });

  it("rejects mixed-case filenames with a warning", async () => {
    writeCommand(commandsDirFor(projectDir), "Review-PR", "body");
    const { commands, warnings } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    expect(commands).toEqual([]);
    expect(warnings.some((w) => w.includes("lowercase"))).toBe(true);
  });

  it("uses first paragraph of body as fallback description", async () => {
    writeCommand(
      commandsDirFor(projectDir),
      "explain",
      "Explain what this function does.\n\nMore details here."
    );
    const { commands } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    expect(commands[0]!.description).toBe("Explain what this function does.");
  });

  it("returns empty list (no warnings) when directories are missing", async () => {
    const { commands, warnings } = await discoverSlashCommands(projectDir, {
      projectDir: join(tmp, "missing-project"),
      userDir: join(tmp, "missing-user"),
    });
    expect(commands).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("parses frontmatter into the command object", async () => {
    writeCommand(
      commandsDirFor(projectDir),
      "review",
      "Body here.",
      "description: Review a PR.\nargument-hint: <pr>\nallowed-tools: [bash]\nmodel: opus"
    );
    const { commands } = await discoverSlashCommands(projectDir, {
      userDir: join(tmp, "none"),
    });
    const c = commands[0]!;
    expect(c.description).toBe("Review a PR.");
    expect(c.argumentHint).toBe("<pr>");
    expect(c.allowedTools).toEqual(["bash"]);
    expect(c.model).toBe("opus");
  });

  it("stable sort: project before user, then alphabetical", async () => {
    const userDir = join(tmp, "user-cmds");
    writeCommand(userDir, "alpha", "u");
    writeCommand(userDir, "beta", "u");
    writeCommand(commandsDirFor(projectDir), "zeta", "p");
    writeCommand(commandsDirFor(projectDir), "alpha", "p");
    const { commands } = await discoverSlashCommands(projectDir, { userDir });
    // project "alpha" first, then project "zeta", then user "beta" (user "alpha" suppressed by collision)
    expect(commands.map((c) => `${c.source}:${c.name}`)).toEqual([
      "project:alpha",
      "project:zeta",
      "user:beta",
    ]);
  });
});

// ---------------------------------------------------------------------------
// findSlashCommand / commandHelpLine
// ---------------------------------------------------------------------------

describe("findSlashCommand", () => {
  const cmds: SlashCommand[] = [
    {
      name: "review",
      description: "Review.",
      path: "/x/review.md",
      source: "project",
      body: "body",
    },
  ];

  it("finds by exact name", () => {
    expect(findSlashCommand(cmds, "review")?.name).toBe("review");
  });

  it("finds case-insensitively", () => {
    expect(findSlashCommand(cmds, "REVIEW")?.name).toBe("review");
  });

  it("returns null for unknown", () => {
    expect(findSlashCommand(cmds, "nope")).toBeNull();
  });
});

describe("commandHelpLine", () => {
  it("renders name, hint, and description", () => {
    const c: SlashCommand = {
      name: "review",
      description: "Review a PR.",
      argumentHint: "<pr>",
      path: "/x",
      source: "project",
      body: "",
    };
    expect(commandHelpLine(c)).toBe("/review <pr> — Review a PR.");
  });

  it("omits hint when absent", () => {
    const c: SlashCommand = {
      name: "clear",
      description: "Clear stuff.",
      path: "/x",
      source: "project",
      body: "",
    };
    expect(commandHelpLine(c)).toBe("/clear — Clear stuff.");
  });
});

// ---------------------------------------------------------------------------
// interpolateTemplate / renderCommandPrompt
// ---------------------------------------------------------------------------

describe("interpolateTemplate", () => {
  it("interpolates $ARGUMENTS", () => {
    expect(interpolateTemplate("do $ARGUMENTS now", "foo bar", ["foo", "bar"])).toBe(
      "do foo bar now"
    );
  });

  it("interpolates $1, $2 positionals (1-indexed)", () => {
    expect(interpolateTemplate("$1 and $2", "a b c", ["a", "b", "c"])).toBe("a and b");
  });

  it("$0 is the whole arg string", () => {
    expect(interpolateTemplate("all: $0", "a b c", ["a", "b", "c"])).toBe("all: a b c");
  });

  it("missing positional yields empty string", () => {
    expect(interpolateTemplate("$1-$5", "a", ["a"])).toBe("a-");
  });

  it("$$ → literal $", () => {
    expect(interpolateTemplate("price: $$5", "", [])).toBe("price: $5");
  });

  it("unknown $word is left untouched", () => {
    expect(interpolateTemplate("$HOME is $ARGUMENTS", "/tmp", ["/tmp"])).toBe(
      "$HOME is /tmp"
    );
  });

  it("case-insensitive $ARGUMENTS", () => {
    expect(interpolateTemplate("$arguments", "x", ["x"])).toBe("x");
  });

  it("empty args produces empty interpolations", () => {
    expect(interpolateTemplate("[$ARGUMENTS][$1]", "", [])).toBe("[][]");
  });
});

describe("renderCommandPrompt", () => {
  const cmd: SlashCommand = {
    name: "review",
    description: "",
    path: "/x",
    source: "project",
    body: "Review PR $1.\nFull args: $ARGUMENTS\n",
  };

  it("renders the body with the given args", () => {
    expect(renderCommandPrompt(cmd, "1234")).toBe(
      "Review PR 1234.\nFull args: 1234\n"
    );
  });

  it("renders multiple positionals", () => {
    expect(renderCommandPrompt(cmd, "1234 extra")).toBe(
      "Review PR 1234.\nFull args: 1234 extra\n"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSlashCommand
// ---------------------------------------------------------------------------

describe("resolveSlashCommand", () => {
  const cmds: SlashCommand[] = [
    {
      name: "review",
      description: "",
      argumentHint: "<pr>",
      path: "/x",
      source: "project",
      body: "Review $1",
    },
    {
      name: "clean",
      description: "",
      path: "/y",
      source: "project",
      body: "Clean up",
    },
  ];

  it("resolves a known command with args", () => {
    const r = resolveSlashCommand("/review 1234", cmds);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.name).toBe("review");
      expect(r.args).toBe("1234");
      expect(r.prompt).toBe("Review 1234");
    }
  });

  it("resolves a command that takes no args", () => {
    const r = resolveSlashCommand("/clean", cmds);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prompt).toBe("Clean up");
    }
  });

  it("returns not-a-command for non-slash input", () => {
    const r = resolveSlashCommand("hello world", cmds);
    expect(r).toEqual({ ok: false, reason: "not-a-command" });
  });

  it("returns not-found for unknown command", () => {
    const r = resolveSlashCommand("/nope", cmds);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "not-found") {
      expect(r.name).toBe("nope");
    }
  });

  it("returns no-args when a command with argument-hint is invoked without args", () => {
    const r = resolveSlashCommand("/review", cmds);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "no-args") {
      expect(r.message).toBe("Usage: /review <pr>");
    }
  });

  it("is case-insensitive on the command name", () => {
    const r = resolveSlashCommand("/REVIEW 5", cmds);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("commandsDirFor joins cwd with .codepilot/commands", () => {
    expect(commandsDirFor("/proj")).toBe(join("/proj", ".codepilot", "commands"));
  });

  it("userCommandsDir uses ~/.codepilot/commands", () => {
    expect(userCommandsDir()).toBe(join(process.env.HOME!, ".codepilot", "commands"));
  });

  it("commandFilePath joins dir + name.md", () => {
    expect(commandFilePath("/d", "review")).toBe(join("/d", "review.md"));
  });

  it("commandDir returns the directory of a command's path", () => {
    const c: SlashCommand = {
      name: "x",
      description: "",
      path: "/a/b/c.md",
      source: "project",
      body: "",
    };
    expect(commandDir(c)).toBe("/a/b");
  });

  it("resolveCommandsDir resolves relative dirs against cwd", () => {
    expect(resolveCommandsDir("/proj", "./cmds")).toBe(join("/proj", "cmds"));
    expect(resolveCommandsDir("/proj", "/abs/cmds")).toBe("/abs/cmds");
  });
});
