import type { AgentMode, PermissionMode, PermissionPresetName, Session } from "@codepilot/core";
import { PERMISSION_PRESETS } from "@codepilot/core";

import type { GoalBridge, PermissionBridge, QuestionBridge, SessionController } from "../controller.js";
import type { SelectOption } from "../SelectMenu.js";

export type { ConnectionInfo } from "./helpers.js";

/** Picker rows for `/preset`, built from the shared preset table so the TUI
 * never drifts from the core definitions. */
export const PRESET_OPTIONS: SelectOption[] = (
  Object.keys(PERMISSION_PRESETS) as PermissionPresetName[]
).map((name) => ({ value: name, label: name, description: PERMISSION_PRESETS[name].description }));

export interface AppProps {
  session: Session;
  controller: SessionController;
  permissionBridge: PermissionBridge;
  questionBridge: QuestionBridge;
  goalBridge: GoalBridge;
  cwd: string;
  model: string | undefined;
  permissionMode: PermissionMode;
  initialAgentMode: AgentMode;
  initialPrompt?: string | undefined;
  connection?: import("./helpers.js").ConnectionInfo | undefined;
}