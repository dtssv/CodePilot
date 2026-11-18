import type { MemoryContents } from "../memory/memory.js";
import type { Skill } from "../skills/skills.js";
import type { AgentMode, PermissionMode, PlanStep } from "../types.js";
import type { EnvironmentProvider } from "../config/env.js";

/**
 * Output style: `concise` (default), `explanatory` (lead with the why,
 * surface trade-offs), or `learning` (also teach concepts a junior engineer
 * would need).
 */
export type OutputStyle = "concise" | "explanatory" | "learning";

/** Built-in sub-agent prompt profiles (specialist short prompts). */
export type SubagentPromptProfile = "explore" | "plan" | "worker";

export interface SystemPromptContext {
  cwd: string;
  /** Session id (for citation in artifacts / logs). */
  sessionId?: string;
  /** Host surface: "cli" | "tui" | "vscode" | "idea". */
  hostSurface?: "cli" | "tui" | "vscode" | "idea";
  memory: MemoryContents;
  plan?: PlanStep[];
  toolNames: string[];
  /**
   * Parent project-bootstrap additions (CODEPILOT.md extras, user overrides)
   * → Project-Specific Notes. Do NOT put sandbox / delivery / resume here —
   * those belong in `sessionNotes` (volatile). Do NOT put sub-agent role here.
   */
  extra?: string;
  /**
   * Session-variant harness notes (sandbox posture, delivery roots, resume,
   * custom agents). Rides the volatile tail so granting a writable root does
   * not bust the cached system prefix.
   */
  sessionNotes?: string;
  model?: string;
  provider?: string;
  /** Collaboration mode (default: "agent"). */
  mode?: AgentMode;
  /** Live permission tier (ask / auto-edit / yolo / …). Surfaced in `<runtime>`. */
  permissionMode?: PermissionMode;
  /** Output style (default: "concise"). */
  outputStyle?: OutputStyle;
  /**
   * Absolute path for this session's scratch directory
   * (`~/.codepilot/projects/<hash>/scratch/<sessionId>/`).
   */
  scratchDir?: string;
  /**
   * Absolute path for this project's runtime state root
   * (`~/.codepilot/projects/<hash>/`).
   */
  projectStateDir?: string;
  /**
   * Directories where intentional project deliverables should land.
   * Defaults to `[cwd]`.
   */
  deliveryRoots?: string[];
  /**
   * Override the environment provider. Tests should always supply a
   * deterministic provider.
   */
  environmentProvider?: EnvironmentProvider;
  /** Skills discovered for this session (stable catalog). */
  skills?: Skill[];
  /**
   * When true, this prompt is for a `task` sub-agent: use a subagent profile
   * and Worker turn (not parent Collaboration Modes).
   */
  subagent?: boolean;
  /**
   * Which specialist static profile to assemble when `subagent` is true.
   * Defaults to `explore` when omitted.
   */
  subagentProfile?: SubagentPromptProfile;
  /** Custom agent body prepended before the standard sub-agent role. */
  subagentCustomBody?: string;
  /** Extra role suffix (e.g. structured-output JSON contract). */
  subagentRoleAddon?: string;
}

export interface SystemPromptResult {
  staticPrefix: string;
  /**
   * Session-stable context (lean env + git identity + memory index + skills).
   * Byte-stable across turns → rides the cached system block.
   */
  stableContext: string;
  /**
   * Volatile per-turn context (time, mode, plan, session notes). Small and
   * expected-fresh → rides `<runtime_context>` on the last user message.
   */
  volatileSuffix: string;
  /** Alias of stableContext (back-compat). */
  dynamicSuffix: string;
  full: string;
}
