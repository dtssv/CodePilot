// `skill` tool — load a skill's full instructions on demand.
//
// Skills advertise themselves in the system prompt as a one-line description
// (see `skillsPromptSection` in `../skills.js`). The full markdown body is
// only fetched when the model explicitly calls this tool, which is the
// progressive-disclosure trick that keeps the static prefix small and
// preserves the prompt cache hit across turns.
//
// The tool takes a `name` (the skill's canonical identifier — matches the
// `name` frontmatter field, falling back to the directory name). It returns
// the full body of the skill, prefixed with a short header so the model can
// see which skill it loaded.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import type { Skill } from "../skills.js";
import { findSkill, matchSkill } from "../skills.js";

const schema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Skill name to load. Must match the `name` from a SKILL.md frontmatter " +
        "(e.g. `commit`, `review`). Substring and keyword matches are also " +
        "tried when an exact name is not found."
    ),
});

/** A pluggable skill store. The default impl does lazy discovery; hosts can
 *  swap in a `StaticSkillStore` for deterministic, pre-discovered data. */
export interface SkillStore {
  /** Return the currently-known skills (synchronous — used by the tool). */
  list(): readonly Skill[];
  /** Look up a skill by exact name first, then by substring/keyword match. */
  byName(name: string): Skill | null;
}

class DefaultSkillStore implements SkillStore {
  private cache: Skill[] | null = null;
  private readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  private async ensureLoaded(): Promise<Skill[]> {
    if (this.cache) return this.cache;
    const { discoverSkills } = await import("../skills.js");
    this.cache = await discoverSkills(this.cwd);
    return this.cache;
  }
  list(): readonly Skill[] {
    return this.cache ?? [];
  }
  /** Async accessor — used by the tool before reading `list()`. */
  async listAsync(): Promise<Skill[]> {
    return this.ensureLoaded();
  }
  byName(name: string): Skill | null {
    const list = this.list();
    const hit = findSkill([...list], name);
    if (hit) return hit;
    return matchSkill([...list], name);
  }
}

/** A frozen, pre-discovered list of skills — the recommended store for the
 *  session layer (call `discoverSkills` once, then hand the result to this). */
export class StaticSkillStore implements SkillStore {
  private readonly skills: Skill[];
  constructor(skills: Skill[]) {
    this.skills = skills.slice();
  }
  list(): readonly Skill[] {
    return this.skills;
  }
  byName(name: string): Skill | null {
    const hit = findSkill([...this.skills], name);
    if (hit) return hit;
    return matchSkill([...this.skills], name);
  }
}

// ---------------------------------------------------------------------------
// The tool itself
// ---------------------------------------------------------------------------

/** Internal handle on the tool — lets the host inject a store at registration
 *  time without polluting the public `ToolDef` surface. */
export interface SkillToolHandle {
  readonly tool: ToolDef<typeof schema>;
  setStore(store: SkillStore): void;
  getStore(): SkillStore | null;
}

/** Create a `skill` tool bound to a discoverable store. The store starts as a
 *  lazy default (discovers on first call against the request's `cwd`); the
 *  session layer is expected to call `setStore(...)` after `discoverSkills`
 *  so the tool is deterministic. */
export function createSkillTool(): SkillToolHandle {
  let store: SkillStore | null = null;
  const fallback = new DefaultSkillStore(process.cwd());
  const tool: ToolDef<typeof schema> = {
    name: "skill",
    description:
      "Load the full instructions of a named skill. Use this when the user request " +
      "matches one of the skills advertised in the system prompt's `<skills>` " +
      "section. The tool returns the skill's complete markdown body — treat it as " +
      "the source of truth for the workflow you should follow. If the name does not " +
      "match exactly, the tool tries a substring / keyword search and returns the " +
      "best match. Call once per skill at the start of the task; do not call it " +
      "repeatedly for the same skill.",
    inputSchema: schema,
    permission: "read",
    async execute(input, ctx) {
      const active = store ?? fallback;
      // Ensure the (possibly async) default store is populated before reading.
      const list = active instanceof DefaultSkillStore
        ? await active.listAsync()
        : active.list();
      const direct = findSkill([...list], input.name);
      const skill = direct ?? matchSkill([...list], input.name);
      if (!skill) {
        const known = list.map((s) => s.name).join(", ");
        return {
          content: `Unknown skill: "${input.name}". Available skills: ${known || "(none discovered)"}`,
          isError: true,
        };
      }
      const headerLines = [
        `# skill: ${skill.name}`,
        `source: ${skill.source}`,
        `path: ${skill.path}`,
      ];
      if (skill.when) headerLines.push(`when: ${skill.when}`);
      if (skill.description) headerLines.push(`description: ${skill.description}`);
      const header = headerLines.join("\n") + "\n";
      return { content: `${header}\n${skill.body.trim()}\n` };
    },
  };
  return {
    tool,
    setStore(s: SkillStore) {
      store = s;
    },
    getStore() {
      return store;
    },
  };
}

// A convenience singleton for hosts that don't need to swap the store. Most
// users (and tests) should prefer `createSkillTool()`.
const defaultHandle = createSkillTool();
export const skillTool: ToolDef<typeof schema> = defaultHandle.tool;
export const setDefaultSkillStore = (s: SkillStore): void =>
  defaultHandle.setStore(s);
