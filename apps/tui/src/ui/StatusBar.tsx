/**
 * Bottom status bar — shows model, permission mode, collaboration mode,
 * session id (first 8 chars), and cumulative token usage.
 *
 * Two distinct mode fields are surfaced because they answer different
 * questions:
 *   - permission mode — how the user is prompted for tool calls
 *   - agent mode      — which tools the model can call (Cursor-style)
 */
import React from "react";
import { Box, Text } from "ink";
import type { AgentMode } from "@codepilot/core";
import type { TuiState } from "./state.js";

const PERM_COLOR: Record<TuiState["permissionMode"], string> = {
  ask: "yellow",
  "auto-edit": "blue",
  yolo: "red",
};

const AGENT_COLOR: Record<AgentMode, string> = {
  chat: "cyan",
  plan: "magenta",
  agent: "green",
};

export function StatusBar({ state }: { state: TuiState }): React.ReactElement {
  const sid = state.sessionId !== undefined ? state.sessionId.slice(0, 8) : "—";
  const total =
    state.usage.input +
    state.usage.output +
    (state.usage.cacheRead ?? 0) +
    (state.usage.cacheWrite ?? 0);
  const cost = state.usage.costUSD !== undefined ? `$${state.usage.costUSD.toFixed(4)}` : "$—";
  const model = state.model ?? "(model unset)";
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text dimColor>model </Text>
        <Text>{model}</Text>
      </Box>
      <Box>
        <Text dimColor>perm </Text>
        <Text color={PERM_COLOR[state.permissionMode]}>{state.permissionMode}</Text>
      </Box>
      <Box>
        <Text dimColor>agent </Text>
        <Text color={AGENT_COLOR[state.agentMode]}>[{state.agentMode}]</Text>
      </Box>
      <Box>
        <Text dimColor>session </Text>
        <Text>{sid}</Text>
      </Box>
      <Box>
        <Text dimColor>tokens </Text>
        <Text>{total.toLocaleString()}</Text>
      </Box>
      <Box>
        <Text dimColor>cost </Text>
        <Text>{cost}</Text>
      </Box>
    </Box>
  );
}
