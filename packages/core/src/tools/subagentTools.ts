// The tool surface granted to sub-agents, by agent type.
// - `explore` (default, read-only): file inspection + network research
//   + read-only lsp_navigate when a language-server manager is wired.
// - `worker`: explore's set plus write/edit/patch/bash and the shared
//   task board for coordinating with peer workers.

import { ToolRegistry } from "./types.js";
import {
  readFileTool,
  readImageTool,
  globTool,
  grepTool,
  lsTool,
  readArtifactTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  bashTool,
} from "./index.js";
import { makeLspNavigateTool } from "./lsp_navigate.js";
import type { LspManager } from "../lsp.js";
import { taskBoardTool } from "./task_board.js";

/** Optional language-server wiring for the read-only `lsp_navigate` tool. The
 * parent session passes its own manager + cwd so sub-agents share the same LSP
 * sessions rather than spinning up their own. When omitted, `lsp_navigate` is
 * simply not registered (an explore agent still has grep/glob/ls). */
export interface SubagentLspWiring {
  getManager: () => LspManager | null;
  getCwd: () => string;
}

export function buildSubagentToolRegistry(
  agentType?: "explore" | "plan" | "worker",
  lsp?: SubagentLspWiring,
): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(readImageTool);
  r.register(globTool);
  r.register(grepTool);
  r.register(lsTool);
  r.register(readArtifactTool);
  // Read-only / side-effect-free network research — available to all types.
  r.register(webFetchTool);
  r.register(webSearchTool);
  // Read-only code navigation (definition/references/hover) — available to all
  // types when the parent provides a language-server manager. The host-backed
  // `diagnostics` tool is deliberately NOT granted (it is on-demand in the main
  // session, not flooded into every sub-agent).
  if (lsp) {
    r.register(makeLspNavigateTool(lsp.getManager, lsp.getCwd));
  }
  if (agentType === "worker") {
    r.register(writeFileTool);
    r.register(editFileTool);
    r.register(applyPatchTool);
    r.register(bashTool);
    r.register(taskBoardTool);
  }
  return r;
}
