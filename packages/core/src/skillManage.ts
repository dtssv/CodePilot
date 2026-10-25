/**
 * Skill install / enable / disable for Settings.
 *
 * - Discovered skills (builtin / user / project / compat) → enable / disable
 * - Catalog skills from connectors (not yet on disk) → install
 * Disable writes to `~/.codepilot/config.json` → `skills.disabled` (keeps files).
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access, mkdtemp, rm, cp, readdir, lstat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { listConnectors, type ConnectorRecipe } from "./connectors.js";
import {
  discoverSkills,
  readDisabledSkillNames,
  type Skill,
  type SkillSource,
} from "./skills.js";
import { getUserConfigPath } from "./config.js";

const execFileAsync = promisify(execFile);

export type ManagedSkillState = "installed" | "available";

export interface ManagedSkill {
  name: string;
  description: string;
  /** installed = on disk / builtin; available = catalog only */
  state: ManagedSkillState;
  /** When installed: whether currently advertised / loadable */
  enabled: boolean;
  source?: SkillSource | "catalog";
  path?: string;
  /** Connector id that can install this skill (catalog entries). */
  connectorId?: string;
  when?: string;
}

function defaultSkillsDir(): string {
  return join(homedir(), ".codepilot", "skills");
}

async function readUserConfig(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(getUserConfigPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeUserConfig(cfg: Record<string, unknown>): Promise<void> {
  const path = getUserConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export type SkillListTab = "all" | "installed" | "available";

export interface SkillListQuery {
  cwd?: string;
  q?: string;
  tab?: SkillListTab;
  offset?: number;
  /** When omitted (or ≤0), return the full filtered set. */
  limit?: number;
}

export interface SkillListPage {
  skills: ManagedSkill[];
  total: number;
  offset: number;
  limit: number;
}

/** Build the full managed-skill map (discovered + catalog). */
async function collectManagedSkills(cwd: string): Promise<ManagedSkill[]> {
  const disabled = new Set(await readDisabledSkillNames());

  // Discover without filtering so Settings can show disabled rows.
  const discovered = await discoverSkills(cwd, {
    applyConfigDisabled: false,
  });

  const byName = new Map<string, ManagedSkill>();
  for (const s of discovered) {
    byName.set(s.name, {
      name: s.name,
      description: s.description,
      state: "installed",
      enabled: !disabled.has(s.name),
      source: s.source,
      path: s.path,
      when: s.when,
    });
  }

  const catalog = await listConnectors();
  for (const c of catalog) {
    if (!c.skill?.name) continue;
    if (byName.has(c.skill.name)) {
      const existing = byName.get(c.skill.name)!;
      existing.connectorId = c.id;
      continue;
    }
    byName.set(c.skill.name, {
      name: c.skill.name,
      description: c.skill.description,
      state: "available",
      enabled: false,
      source: "catalog",
      connectorId: c.id,
    });
  }

  return [...byName.values()].sort((a, b) => {
    if (a.state !== b.state) return a.state === "installed" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function skillMatchesQuery(s: ManagedSkill, q: string): boolean {
  if (!q) return true;
  const hay = `${s.name} ${s.description}`.toLowerCase();
  return hay.includes(q);
}

/** Filtered + paginated skills for Settings. */
export async function queryManagedSkills(opts?: SkillListQuery): Promise<SkillListPage> {
  const cwd = opts?.cwd ?? process.cwd();
  const all = await collectManagedSkills(cwd);
  const q = (opts?.q ?? "").trim().toLowerCase();
  const tab = opts?.tab ?? "all";
  const filtered = all.filter((s) => {
    if (!skillMatchesQuery(s, q)) return false;
    if (tab === "installed" && s.state !== "installed") return false;
    if (tab === "available" && s.state !== "available") return false;
    return true;
  });
  const total = filtered.length;
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit =
    typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : total;
  return {
    skills: filtered.slice(offset, offset + limit),
    total,
    offset,
    limit,
  };
}

/** All managed skills: discovered (with enable flag) + catalog not yet installed. */
export async function listManagedSkills(cwd: string = process.cwd()): Promise<ManagedSkill[]> {
  const page = await queryManagedSkills({ cwd });
  return page.skills;
}

export interface InstallSkillResult {
  skillPath: string;
  message: string;
}

/** Install a catalog skill (from a connector recipe) into ~/.codepilot/skills. */
export async function installSkillFromConnector(
  connectorId: string,
  opts?: { skillsDir?: string },
): Promise<InstallSkillResult> {
  const catalog = await listConnectors();
  const recipe = catalog.find((c) => c.id === connectorId);
  if (!recipe?.skill) {
    throw new Error(`连接器无配套技能：${connectorId}`);
  }
  return writeSkillRecipe(recipe, opts?.skillsDir);
}

async function writeSkillRecipe(
  recipe: ConnectorRecipe,
  skillsDir?: string,
): Promise<InstallSkillResult> {
  const skill = recipe.skill!;
  const root = skillsDir ?? defaultSkillsDir();
  const dir = join(root, skill.name);
  await mkdir(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  const md = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body.trim()}\n`;
  await writeFile(skillPath, md, "utf-8");
  return {
    skillPath,
    message: `已安装技能「${skill.name}」。重新加载后可用。`,
  };
}

/** Enable or disable a skill (disabled names stay on disk but are not discovered). */
export async function setSkillEnabled(
  name: string,
  enabled: boolean,
): Promise<{ name: string; enabled: boolean; message: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("技能名不能为空");

  const cfg = await readUserConfig();
  const skills =
    cfg.skills && typeof cfg.skills === "object"
      ? ({ ...(cfg.skills as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const prev = Array.isArray(skills.disabled)
    ? (skills.disabled as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const set = new Set(prev);
  if (enabled) set.delete(trimmed);
  else set.add(trimmed);
  skills.disabled = [...set].sort();
  cfg.skills = skills;
  await writeUserConfig(cfg);

  return {
    name: trimmed,
    enabled,
    message: enabled
      ? `已启用技能「${trimmed}」。新会话生效。`
      : `已停用技能「${trimmed}」。文件仍保留，可随时启用。`,
  };
}

/** Whether a user skill directory exists under ~/.codepilot/skills/<name>. */
export async function userSkillInstalled(
  name: string,
  skillsDir?: string,
): Promise<boolean> {
  try {
    await access(join(skillsDir ?? defaultSkillsDir(), name, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

export interface SkillContent {
  name: string;
  markdown: string;
  path: string;
  source?: SkillSource | "catalog";
  /** True when saving will write to a user override (builtin / read-only source). */
  editablePath: string;
  readOnlySource: boolean;
  /** Skill folder root on disk (contains SKILL.md and optional companions). */
  rootDir: string;
  /**
   * Relative paths under the skill folder that look editable as text
   * (SKILL.md first, then templates/references/scripts/assets/…).
   */
  files: string[];
}

const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".xml",
  ".csv",
  ".tsv",
  ".tmpl",
  ".template",
  ".hbs",
  ".ejs",
  ".j2",
  ".jinja",
  ".jinja2",
  ".mustache",
  ".liquid",
  ".sql",
  ".graphql",
  ".gql",
  ".env",
  ".example",
  ".gitignore",
]);

const MAX_SKILL_FILES = 120;
const MAX_SKILL_DEPTH = 5;

async function walkSkillTextFiles(
  root: string,
  dir: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (out.length >= MAX_SKILL_FILES || depth > MAX_SKILL_DEPTH) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  entries.sort((a, b) => a.localeCompare(b));
  for (const name of entries) {
    if (name === "." || name === ".." || name.startsWith(".")) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await walkSkillTextFiles(root, abs, depth + 1, out);
      continue;
    }
    if (!st.isFile()) continue;
    const ext = extname(name).toLowerCase();
    const base = basename(name);
    const textish =
      TEXT_EXT.has(ext) ||
      base === "SKILL.md" ||
      base === "Makefile" ||
      base === "Dockerfile" ||
      !ext;
    if (!textish) continue;
    if (st.size > 1_500_000) continue; // skip huge blobs
    out.push(relative(root, abs).split(sep).join("/"));
    if (out.length >= MAX_SKILL_FILES) return;
  }
}

async function listSkillCompanionFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkSkillTextFiles(rootDir, rootDir, 0, files);
  files.sort((a, b) => {
    if (a === "SKILL.md") return -1;
    if (b === "SKILL.md") return 1;
    return a.localeCompare(b);
  });
  return files;
}

function resolveSkillRelativePath(rootDir: string, relativePath: string): string {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!rel || rel.includes("\0") || rel.split("/").some((p) => p === "..")) {
    throw new Error(`非法技能文件路径：${relativePath}`);
  }
  const abs = resolve(rootDir, rel);
  const rootResolved = resolve(rootDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error(`非法技能文件路径：${relativePath}`);
  }
  return abs;
}

/**
 * Ensure we have a writable skill directory. Builtin/compat skills are copied
 * wholesale to ~/.codepilot/skills/<name>/ so templates/assets come along.
 */
async function ensureEditableSkillRoot(
  name: string,
  cwd: string,
): Promise<{ rootDir: string; copiedFromReadonly: boolean }> {
  const discovered = await discoverSkills(cwd, { applyConfigDisabled: false });
  const hit = discovered.find((s) => s.name === name);
  if (!hit) throw new Error(`未找到技能：${name}`);

  const sourceRoot = dirname(hit.path);
  const readOnly = hit.source === "builtin" || hit.source === "compat";
  if (!readOnly) {
    return { rootDir: sourceRoot, copiedFromReadonly: false };
  }

  const userRoot = join(defaultSkillsDir(), name);
  try {
    await access(join(userRoot, "SKILL.md"));
    return { rootDir: userRoot, copiedFromReadonly: false };
  } catch {
    /* need copy */
  }
  await mkdir(join(userRoot, ".."), { recursive: true });
  await cp(sourceRoot, userRoot, { recursive: true });
  return { rootDir: userRoot, copiedFromReadonly: true };
}

/** Load full SKILL.md for editing. Builtin skills are readable; save copies to user dir. */
export async function getSkillContent(
  name: string,
  cwd: string = process.cwd(),
): Promise<SkillContent> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("技能名不能为空");

  const discovered = await discoverSkills(cwd, { applyConfigDisabled: false });
  const hit = discovered.find((s) => s.name === trimmed);
  if (!hit) throw new Error(`未找到技能：${trimmed}`);

  let markdown: string;
  try {
    markdown = await readFile(hit.path, "utf-8");
  } catch {
    markdown = `---\nname: ${hit.name}\ndescription: ${hit.description}\n---\n\n${hit.body.trim()}\n`;
  }

  const rootDir = dirname(hit.path);
  const userPath = join(defaultSkillsDir(), trimmed, "SKILL.md");
  const readOnlySource = hit.source === "builtin" || hit.source === "compat";
  const editablePath =
    hit.source === "user" || hit.source === "project" ? hit.path : userPath;
  const files = await listSkillCompanionFiles(rootDir);

  return {
    name: hit.name,
    markdown,
    path: hit.path,
    source: hit.source,
    editablePath,
    readOnlySource,
    rootDir,
    files: files.length > 0 ? files : ["SKILL.md"],
  };
}

export interface SkillFileContent {
  name: string;
  relativePath: string;
  content: string;
  rootDir: string;
  readOnlySource: boolean;
}

/** Read one text file inside a skill folder (e.g. templates/foo.md). */
export async function getSkillFile(
  name: string,
  relativePath: string,
  cwd: string = process.cwd(),
): Promise<SkillFileContent> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("技能名不能为空");
  const info = await getSkillContent(trimmed, cwd);
  const abs = resolveSkillRelativePath(info.rootDir, relativePath || "SKILL.md");
  const content = await readFile(abs, "utf-8");
  return {
    name: info.name,
    relativePath: relative(info.rootDir, abs).split(sep).join("/"),
    content,
    rootDir: info.rootDir,
    readOnlySource: info.readOnlySource,
  };
}

export interface SaveSkillResult {
  name: string;
  path: string;
  message: string;
}

/**
 * Save skill markdown. Writes to the skill's path when user/project;
 * otherwise writes a user override under ~/.codepilot/skills/<name>/.
 */
export async function saveSkillContent(
  name: string,
  markdown: string,
  cwd: string = process.cwd(),
): Promise<SaveSkillResult> {
  return saveSkillFile(name, "SKILL.md", markdown, cwd);
}

/**
 * Save any text file under the skill folder. For builtin skills, copies the
 * whole skill directory to ~/.codepilot/skills/<name>/ first (so templates stay).
 */
export async function saveSkillFile(
  name: string,
  relativePath: string,
  content: string,
  cwd: string = process.cwd(),
): Promise<SaveSkillResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("技能名不能为空");
  const rel = (relativePath || "SKILL.md").replace(/\\/g, "/").replace(/^\/+/, "");
  const body = content;
  if (rel === "SKILL.md") {
    const trimmedBody = body.trim();
    if (!trimmedBody) throw new Error("技能内容不能为空");
    if (!trimmedBody.startsWith("---")) {
      throw new Error("SKILL.md 必须以 YAML frontmatter（---）开头");
    }
  }

  const { rootDir, copiedFromReadonly } = await ensureEditableSkillRoot(trimmed, cwd);
  const target = resolveSkillRelativePath(rootDir, rel);
  await mkdir(dirname(target), { recursive: true });
  const toWrite =
    rel === "SKILL.md"
      ? body.trimEnd() + "\n"
      : body.endsWith("\n")
        ? body
        : body + "\n";
  await writeFile(target, toWrite, "utf-8");

  return {
    name: trimmed,
    path: target,
    message: copiedFromReadonly
      ? `已将「${trimmed}」复制为用户技能并保存 ${rel}：${rootDir}`
      : `已保存 ${rel}`,
  };
}

/** Starter prompt for Settings / composer when creating a skill via skill-creator. */
export const SKILL_CREATOR_STARTER_PROMPT =
  "请用 skill 工具加载 skill-creator 技能，按它的流程帮我创建（或改进）一个 CodePilot 技能。" +
  "先确认用途、触发场景与存放位置（默认 ~/.codepilot/skills/），再写入 SKILL.md。";

function archiveKind(filename: string): "zip" | "7z" | "tar" | "tgz" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  return null;
}

async function extractArchive(archivePath: string, dest: string, kind: string): Promise<void> {
  if (kind === "zip") {
    await execFileAsync("unzip", ["-o", "-q", archivePath, "-d", dest], { timeout: 120_000 });
    return;
  }
  if (kind === "tgz") {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", dest], { timeout: 120_000 });
    return;
  }
  if (kind === "tar") {
    await execFileAsync("tar", ["-xf", archivePath, "-C", dest], { timeout: 120_000 });
    return;
  }
  if (kind === "7z") {
    for (const bin of ["7z", "7zz", "bsdtar"] as const) {
      try {
        if (bin === "bsdtar") {
          await execFileAsync(bin, ["-xf", archivePath, "-C", dest], { timeout: 120_000 });
        } else {
          await execFileAsync(bin, ["x", `-o${dest}`, "-y", archivePath], { timeout: 120_000 });
        }
        return;
      } catch {
        /* try next */
      }
    }
    throw new Error("无法解压 .7z：请安装 7z / 7zz，或改用 .zip");
  }
  throw new Error(`不支持的压缩格式：${kind}`);
}

async function walkSkillMd(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "__MACOSX") continue;
    const full = join(dir, name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkSkillMd(full, out, depth + 1);
    } else if (st.isFile() && name === "SKILL.md") {
      out.push(full);
    }
  }
}

function skillNameFromMarkdown(md: string, fallback: string): string {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (m) {
    const nameLine = m[1].match(/^name:\s*(.+)$/m);
    if (nameLine) {
      const n = nameLine[1].trim().replace(/^["']|["']$/g, "");
      if (n) return n.replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
    }
  }
  return fallback;
}

export interface InstallSkillArchiveResult {
  names: string[];
  replaced: string[];
  skillPaths: string[];
  message: string;
}

/**
 * Install skill(s) from a uploaded archive (.zip / .7z / .tar / .tar.gz).
 * Finds every SKILL.md, copies its parent folder into ~/.codepilot/skills/<name>/,
 * replacing an existing skill of the same name.
 */
export async function installSkillFromArchive(
  input: { filename: string; dataBase64: string },
  opts?: { skillsDir?: string },
): Promise<InstallSkillArchiveResult> {
  const filename = (input.filename || "skill.zip").trim();
  const kind = archiveKind(filename);
  if (!kind) {
    throw new Error("仅支持 .zip、.7z、.tar、.tar.gz / .tgz");
  }
  const raw = input.dataBase64?.trim();
  if (!raw) throw new Error("空文件");
  const buf = Buffer.from(raw.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (buf.length === 0) throw new Error("空文件");
  if (buf.length > 40 * 1024 * 1024) throw new Error("压缩包过大（上限 40MB）");

  const work = await mkdtemp(join(tmpdir(), "cp-skill-"));
  const archivePath = join(work, basename(filename).replace(/[^\w.\-]+/g, "_") || `skill${extname(filename)}`);
  const extractDir = join(work, "out");
  try {
    await writeFile(archivePath, buf);
    await mkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir, kind);

    const skillMds: string[] = [];
    await walkSkillMd(extractDir, skillMds);
    if (skillMds.length === 0) {
      throw new Error("压缩包内未找到 SKILL.md");
    }

    const root = opts?.skillsDir ?? defaultSkillsDir();
    await mkdir(root, { recursive: true });
    const names: string[] = [];
    const replaced: string[] = [];
    const skillPaths: string[] = [];

    for (const mdPath of skillMds) {
      const folder = join(mdPath, "..");
      const md = await readFile(mdPath, "utf-8");
      const fallback = basename(folder) || "skill";
      const name = skillNameFromMarkdown(md, fallback);
      const dest = join(root, name);
      const existed = await userSkillInstalled(name, root);
      await rm(dest, { recursive: true, force: true });
      await cp(folder, dest, { recursive: true });
      names.push(name);
      skillPaths.push(join(dest, "SKILL.md"));
      if (existed) replaced.push(name);
    }

    const unique = [...new Set(names)];
    return {
      names: unique,
      replaced: [...new Set(replaced)],
      skillPaths,
      message:
        replaced.length > 0
          ? `已安装技能：${unique.join(", ")}（替换：${[...new Set(replaced)].join(", ")}）`
          : `已安装技能：${unique.join(", ")}`,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** @internal — kept for callers that may want to validate extensions client-side. */
export function supportedSkillArchiveExts(): string[] {
  return [".zip", ".7z", ".tar", ".tar.gz", ".tgz"];
}

export type { Skill };
