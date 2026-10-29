// The tool surface granted to sub-agents, by agent type.
//
// Kept in one place (and exported) so the set is single-sourced and testable,
// rather than buried in a closure inside session.ts. See subagent.ts for the
// prompt text that tells the model which of these it has.
//
// - `explore` (default, read-only): file inspection + network research. The
//   network tools (`web_fetch` / `web_search`) are read-only and
//   side-effect-free, and research is the whole point of an explore agent, so
//   they are included for every type.
// - `worker`: everything explore has, plus write/edit/patch/bash to carry out
//   a delegated change (and verify it).

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

export function buildSubagentToolRegistry(agentType?: "explore" | "worker"): ToolRegistry {
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
  if (agentType === "worker") {
    r.register(writeFileTool);
    r.register(editFileTool);
    r.register(applyPatchTool);
    r.register(bashTool);
  }
  return r;
}
