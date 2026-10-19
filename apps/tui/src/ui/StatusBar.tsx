/**
 * Bottom status bar — shows model, permission mode, collaboration mode,
 * session id (first 8 chars), and cumulative token usage.
 *
 * Two distinct mode fields are surfaced because they answer different
 * questions:
 * - permission mode — how the user is prompted for tool calls
 * - agent mode — which tools the model can call 
 *
 * When `config.statusLine` is configured, a custom
 * command is spawned on each update and its stdout replaces the default
 * status bar content. ANSI color codes are preserved.
 */
import React from "react";
import { Box, Text } from "ink";
import type { AgentMode, StatusLineConfig } from "@codepilot/core";
import { runStatusLine, buildPayload } from "@codepilot/core";
import type { TuiState } from "./state.js";
import { color, formatTokens, glyph } from "./theme.js";

const PERM_COLOR: Record<TuiState["permissionMode"], string | undefined> = {
  ask: undefined,
  "auto-edit": color.info,
  yolo: color.remove,
};

/** Same names as the mode switch in the other clients. */
const AGENT_LABEL: Record<AgentMode, string> = {
  chat: "Ask",
  plan: "Plan",
  agent: "Agent",
};

const AGENT_COLOR: Record<AgentMode, string> = {
  chat: color.info,
  plan: color.warn,
  agent: color.accent,
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

  const sid = state.sessionId !== undefined ? state.sessionId.slice(0, 8) : undefined;
  const total =
    state.usage.input +
    state.usage.output +
    (state.usage.cacheRead ?? 0) +
    (state.usage.cacheWrite ?? 0);
  const sep = <Text color={color.faint}> {glyph.dot} </Text>;
  return (
    <Box paddingX={1}>
      <Text color={AGENT_COLOR[state.agentMode]} bold>
        {glyph.running} {AGENT_LABEL[state.agentMode]}
      </Text>
      {sep}
      <Text color={PERM_COLOR[state.permissionMode]} dimColor={state.permissionMode === "ask"}>
        {state.permissionMode}
      </Text>
      {sep}
      <Text dimColor>
        {state.providerId
          ? `${state.providerId} · ${state.model ?? "?"}`
          : (state.model ?? "model unset")}
      </Text>
      <Box flexGrow={1} />
      <Text color={color.faint}>
        {formatTokens(total)} tokens
        {state.usage.costUSD !== undefined ? ` ${glyph.dot} $${state.usage.costUSD.toFixed(4)}` : ""}
        {sid ? ` ${glyph.dot} ${sid}` : ""}
      </Text>
    </Box>
  );
}
