// Session built-in tool registration. Extracted from Session so the wiring
// table stays testable and session.ts does not own every tool import.

import { extractPlan } from "../compaction/compaction.js";
import { FileMemorySink } from "../memory/memory.js";
import type { RedactionPattern } from "../permissions/redact.js";
import type { PermissionEngine } from "../permissions/permissions.js";
import { createSubagentRunner } from "../subagent/subagent.js";
import { writePlanFile } from "../subagent/plans.js";
import type { CustomAgent } from "../skills/customAgents.js";
import { createSkillTool, type SkillToolHandle } from "../tools/skill.js";
import { buildSubagentToolRegistry } from "../tools/subagentTools.js";
import { makeLspNavigateTool } from "../tools/lsp_navigate.js";
import type { ArtifactStore } from "../tools/artifacts.js";
import {
  bashTool,
  bashOutputTool,
  bashKillTool,
  writeStdinTool,
  notebookEditTool,
  webFetchTool,
  webSearchTool,
  imageGenTool,
  resolveImageEndpoint,
  readFileTool,
  readImageTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  makeCodeModeTool,
  harnessBridgeTool,
  diagnosticsTool,
  globTool,
  grepTool,
  lsTool,
  planTool,
  memoryWriteTool,
  readArtifactTool,
  taskTool,
  askUserQuestionTool,
  startNewTaskTool,
  suggestModeTool,
  goalTool,
  makeMcpMetaTool,
  makeToolCatalogTool,
  type BackgroundSubagentMeta,
  type BackgroundSubagentRegistry,
} from "../tools/index.js";
import type { ToolRegistry } from "../tools/types.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { ResolvedSandbox } from "../sandbox/sandbox.js";
import type { McpManager } from "../mcp/mcp.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  PermissionRequest,
  PermissionResolution,
  SessionOptions,
} from "../types.js";
import { LspManager } from "../workspace/lsp.js";
import type { PostWrite } from "../workspace/postWrite.js";
import { projectStatePath, scratchDir } from "../workspace/projectState.js";

export type BuiltinHost = {
  toolRegistry: ToolRegistry;
  config: CodepilotConfig;
  cwd: string;
  id: string;
  mode: AgentMode;
  model: string;
  events: Event[];
  autoAcceptModeSuggestions: boolean;
  onGoalRequest?: SessionOptions["onGoalRequest"];
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
  onAskUser?: SessionOptions["onAskUser"];
  permissions: PermissionEngine;
  sandbox: ResolvedSandbox;
  deliveryRoots: string[];
  artifacts: ArtifactStore;
  customAgents: Map<string, CustomAgent>;
  postWrite: PostWrite;
  hooks: HookEngine;
  redactPatterns: readonly RedactionPattern[];
  backgroundSubagents: BackgroundSubagentRegistry;
  skillToolHandle: SkillToolHandle | null;
  lspManager: LspManager | null;
  lastPlanSlug: string | null;
  /** Live MCP manager (null until startup finishes / when none configured). */
  getMcpManager?: () => McpManager | null;
  clearWorkingContext(reason?: string): Promise<boolean>;
  expandWritablePath(dir: string, opts?: { persist?: boolean }): Promise<string>;
  addDeliveryRoot(dir: string): void;
  getEvents(): Event[];
  deliverBackgroundCompletion(meta: BackgroundSubagentMeta): void;
  wireHookResolvers(subagentRunner: ReturnType<typeof createSubagentRunner> | undefined): void;
};

export function registerSessionBuiltins(host: BuiltinHost): void {
  host.toolRegistry.register(bashTool);
  host.toolRegistry.register(bashOutputTool);
  host.toolRegistry.register(bashKillTool);
  host.toolRegistry.register(writeStdinTool);
  host.toolRegistry.register(notebookEditTool);
  host.toolRegistry.register(webFetchTool);
  host.toolRegistry.register(webSearchTool);
  // image_gen is opt-in: only register when an image endpoint is configured
  // (baseURL + apiKey), since not every provider can generate images.
  if (resolveImageEndpoint(host.config.imageGen)) {
    imageGenTool.config = host.config.imageGen;
    host.toolRegistry.register(imageGenTool);
  }
  host.toolRegistry.register(readFileTool);
  host.toolRegistry.register(readImageTool);
  host.toolRegistry.register(writeFileTool);
  host.toolRegistry.register(editFileTool);
  host.toolRegistry.register(applyPatchTool);
  // Opt-out: `codeMode.enabled: false` drops the tool from the schema table.
  // Bound to the live registry so deferred tools are reachable via tools.*.
  if (host.config.codeMode?.enabled !== false) {
    host.toolRegistry.register(makeCodeModeTool(() => host.toolRegistry));
  }
  // harness_bridge invokes an external agent CLI (claude/codex/custom) as a
  // sandboxed subprocess. Opt-in: only register when explicitly enabled, so
  // the tool table isn't polluted on hosts without those CLIs installed.
  if (host.config.enableHarnessBridge === true) {
    host.toolRegistry.register(harnessBridgeTool);
  }
  host.toolRegistry.register(diagnosticsTool);
  host.toolRegistry.register(globTool);
  host.toolRegistry.register(grepTool);
  host.toolRegistry.register(lsTool);
  host.toolRegistry.register(readArtifactTool);
  host.toolRegistry.register(askUserQuestionTool);

 // The tools below carry per-session wiring (sink, plan file, sub-agent
 // runner). The exported objects are module singletons shared by every
 // session in the process, so each session registers its own copy —
 // mutating the shared one let the newest session's runner (its endpoint,
 // cwd and transcript) serve every other session's `task` calls.
  const memoryWrite = { ...memoryWriteTool };
  const plan = { ...planTool };
  const task = { ...taskTool };
  // start_new_task: model-triggered task boundary → clearWorkingContext.
  const startNewTask = { ...startNewTaskTool };
  startNewTask.onStartNewTask = (reason) => host.clearWorkingContext(reason);
  host.toolRegistry.register(startNewTask);
  // suggest_mode: model proposes a collaboration-mode switch; the user
  // confirms (or auto-accepts). Per-session copy so the wiring is isolated.
  const suggestMode = { ...suggestModeTool };
  suggestMode.currentMode = () => host.mode;
  suggestMode.autoAccept = () => host.autoAcceptModeSuggestions;
  host.toolRegistry.register(suggestMode);
  // goal: escalate into a multi-round loop or report terminal status.
  const goal = { ...goalTool };
  goal.onStartGoal = async (objective, maxRounds, reason) => {
    if (!host.onGoalRequest) return false;
    return await host.onGoalRequest({
      objective,
      ...(maxRounds ? { maxRounds } : {}),
      ...(reason ? { reason } : {}),
    });
  };
  host.toolRegistry.register(goal);
  host.toolRegistry.register(memoryWrite);
  const skillHandle = createSkillTool();
  host.skillToolHandle = skillHandle;
  host.toolRegistry.register(skillHandle.tool);
  host.lspManager = new LspManager(host.config.lsp?.servers);
  host.toolRegistry.register(
    makeLspNavigateTool(() => host.lspManager, () => host.cwd),
  );
  host.toolRegistry.register(task);
  host.toolRegistry.register(plan);
  // When deferredWire is on (default with code_mode), plugin discovery goes
  // through code_mode.tools.* — skip competing plugin meta-tools. The `mcp`
  // meta stays registered (and is on DIRECT_WIRE_TOOLS) so prompts/resources
  // remain reachable without per-item FC tools.
  const deferredWire =
    host.config.codeMode?.enabled !== false &&
    host.config.codeMode?.deferredWire !== false;
  const hasMcp = Object.values(host.config.mcpServers ?? {}).some((c) => c && !c.disabled);
  if (hasMcp) {
    host.toolRegistry.register(
      makeMcpMetaTool(
        () => host.toolRegistry,
        () => host.getMcpManager?.() ?? null,
      ),
    );
  }
  // `tool_catalog` for plugin tools under lazy discovery — only when not
  // using code_mode deferred wire (which replaces this path).
  const pluginDiscovery = host.config.pluginToolDiscovery ?? "eager";
  if (
    !deferredWire &&
    (pluginDiscovery === "lazy" || pluginDiscovery === "auto")
  ) {
    host.toolRegistry.register(
      makeToolCatalogTool(() => host.toolRegistry, (t) => t.source === "plugin"),
    );
  }

 // Wire the memory sink (MEMORY.md + progressive index/topic mirror).
  memoryWrite.sink = new FileMemorySink(host.cwd, {
    autoMemory:
      host.config.autoMemoryEnabled === false ? false : { enabled: true },
    redactPatterns: host.redactPatterns,
  });

 // Plan-file persistence for `plan` action=done.
  plan.writePlan = async (summary, steps) => {
    const pf = await writePlanFile(host.cwd, host.id, summary, steps, {
      plansDirectory: host.config.plansDirectory,
      status: "pending",
    });
    host.lastPlanSlug = pf.slug;
    return pf.path;
  };
  plan.currentPlan = () => extractPlan(host.events);

 // Wire the subagent runner so `task` works. "explore" agents are
 // read-only; "worker" agents additionally get write + bash tools.
  task.runner = createSubagentRunner({
    cwd: host.cwd,
    config: host.config,
    model: host.model,
    getEndpoint: () => ({ config: host.config, model: host.model }),
    permissions: host.permissions,
    onPermissionRequest: host.onPermissionRequest,
    onAskUser: host.onAskUser,
    getSandbox: () => host.sandbox,
    expandSandboxWritable: (dir, opts) =>
      host.expandWritablePath(dir, opts).then(() => undefined),
    getDeliveryRoots: () => host.deliveryRoots,
    addDeliveryRoot: (dir) => host.addDeliveryRoot(dir),
    scratchDir: () => scratchDir(host.cwd, host.id),
    projectStateDir: () => projectStatePath(host.cwd),
    getArtifacts: () => host.artifacts,
    // Model-visible history for a `context: "fork"` sub-agent — the same
    // post-compaction working set the model itself sees.
    getParentEvents: () => host.getEvents(),
    buildToolRegistry: (agentType) =>
      buildSubagentToolRegistry(agentType, {
        getManager: () => host.lspManager,
        getCwd: () => host.cwd,
      }),
    hooks: host.hooks,
    resolveCustomAgent: async (name) => host.customAgents.get(name),
    postWrite: host.postWrite,
  });
 // Per-sub-agent wall-clock budget (optional). Enforced by the task tool's
 // shared semaphore so a stuck worker can't starve a parallel fan-out.
  task.subagentTimeoutMs = host.config.subagentTimeoutMs;
 // Scale knobs for large fan-out (config-overridable, conservative defaults):
 // nesting depth, concurrent threads, and a total-spawn cap that bounds the
 // whole run regardless of tree shape. See tools/task.ts for the guards.
  if (typeof host.config.subagentMaxDepth === "number") task.maxDepth = host.config.subagentMaxDepth;
  if (typeof host.config.subagentMaxThreads === "number") task.maxThreads = host.config.subagentMaxThreads;
  if (typeof host.config.subagentMaxTotal === "number") task.maxTotal = host.config.subagentMaxTotal;
  // Background sub-agents (`run: "background"`): a per-session registry so a
  // dispatched job can be listed / waited / interrupted via task action=…,
  // and so its one-time completion summary is steered back to the parent.
  task.backgroundRegistry = host.backgroundSubagents;
  host.backgroundSubagents.onCompletion((meta) => {
    host.deliverBackgroundCompletion(meta);
  });

  host.wireHookResolvers(task.runner);
}