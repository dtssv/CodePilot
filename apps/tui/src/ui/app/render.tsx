import React from "react";
import { Box } from "ink";

import { TranscriptItem, WelcomeBanner } from "../TranscriptView.js";
import type { AgentMode, PermissionMode } from "@codepilot/core";
import type { PrintedItem } from "./helpers.js";

export interface RenderPrintedContext {
  model: string | undefined;
  providerId: string | undefined;
  cwd: string;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  connection: string | undefined;
  width: number;
}

export function renderPrintedItem(item: PrintedItem, ctx: RenderPrintedContext): React.ReactElement {
  return item.row ? (
    <Box key={item.key} paddingX={1} flexDirection="column">
      <TranscriptItem row={item.row} />
    </Box>
  ) : (
    <Box key={item.key} paddingX={1}>
      <WelcomeBanner
        version="1.0.0"
        model={ctx.model}
        providerId={ctx.providerId}
        cwd={ctx.cwd}
        agentMode={ctx.agentMode}
        permissionMode={ctx.permissionMode}
        connection={ctx.connection}
        width={ctx.width}
      />
    </Box>
  );
}