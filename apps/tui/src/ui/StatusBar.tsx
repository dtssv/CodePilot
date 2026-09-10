/**
 * Bottom status bar — shows model, permission mode, collaboration mode,
 * session id (first 8 chars), and cumulative token usage.
 *
 * Two distinct mode fields are surfaced because they answer different
 * questions:
 *   - permission mode — how the user is prompted for tool calls
 *   - agent mode      — which tools the model can call (Cursor-style)
 *
 * When `config.statusLine` is configured (claude-code-style), a custom
 * command is spawned on each update and its stdout replaces the default
 * status bar content. ANSI color codes are preserved.
 */
import React from "react";
import { Box, Text } from "ink";
import type { AgentMode, StatusLineConfig } from "@codepilot/core";
import { runStatusLine, buildPayload } from "@codepilot/core";
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

export function StatusBar({
  state,
  statusLineConfig,
  cwd,
  version,
}: {
  state: TuiState;
  statusLineConfig?: StatusLineConfig;
  cwd: string;
  version: string;
}): React.ReactElement {
  const [customText, setCustomText] = React.useState<string | null>(null);

  // Run the custom status-line script on state changes (debounced).
  React.useEffect(() => {
    if (!statusLineConfig) return;
    const totalInput = state.usage.input + (state.usage.cacheRead ?? 0);
    const totalOutput = state.usage.output;
    const windowSize = 200_000; // default; could be derived from model
    const total = totalInput + totalOutput;
    const usedPct = total > 0 && windowSize > 0 ? (total / windowSize) * 100 : null;
    const payload = buildPayload({
      sessionId: state.sessionId ?? "—",
      renderWidth: process.stdout.columns ?? 120,
      cwd,
      model: state.model ?? "(unset)",
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      contextWindowSize: windowSize,
      usedPercentage: usedPct,
      version,
    });
    let cancelled = false;
    const timer = setTimeout(() => {
      runStatusLine(statusLineConfig, payload, { cwd }).then((r) => {
        if (!cancelled && r.ok) setCustomText(r.text);
      });
    }, statusLineConfig.updateIntervalMs ?? 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state.model, state.sessionId, state.usage, statusLineConfig, cwd, version]);

  // Custom status line: render the script's stdout (preserving ANSI).
  if (statusLineConfig && customText !== null) {
    return (
      <Box paddingX={(statusLineConfig.padding ?? 0) + 1}>
        <Text>{customText}</Text>
      </Box>
    );
  }

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
