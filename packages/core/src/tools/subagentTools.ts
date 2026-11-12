// The tool surface granted to sub-agents, by agent type.
//
// Kept in one place (and exported) so the set is single-sourced and testable,
// rather than buried in a closure inside session.ts. See subagent.ts for the
// prompt text that tells the model which of these it has.
//
// - `explore` (default, read-only): file inspection + network research. The
//   network tools (`web_fetch` / `web_search`) are read-only and
//   side-effect-free, and research is the whole point of an explore agent, so
//   they are included for every type. The read-only `lsp_navigate` is included
//   for every type when the parent wires a language-server manager, so an
//   explore agent can jump to definitions/references instead of grepping.
// - `worker`: everything explore has, plus write/edit/patch/bash to carry out
//   a delegated change (and verify it), and the shared task board for
//   coordinating with peer workers.

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
