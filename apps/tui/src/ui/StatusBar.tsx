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
import { Box, Text, useStdout } from "ink";
import type { AgentMode, StatusLineConfig } from "@codepilot/core";
import {
  runStatusLine,
  buildPayload,
  renderPresetStatusLine,
  readGitBranch,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from "@codepilot/core";

/** The camelCase rate-limit snapshot the session captures from provider headers
 * (mapped into the status-line payload by buildPayload). */
type RateLimitSnapshot = { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number };
import type { TuiState } from "./state.js";
import { color, formatTokens, glyph } from "./theme.js";
import { textWidth } from "./textWidth.js";

/** Separator between status segments. */
const DOT = ` ${glyph.dot} `;

interface Seg {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** Display width of a segment run, separators included. */
function runWidth(segs: readonly Seg[]): number {
  if (segs.length === 0) return 0;
  let n = 0;
  for (const s of segs) n += textWidth(s.text);
  return n + DOT.length * (segs.length - 1);
}

// Read `color.*` at call time, not module load: the palette is mutable
// (setTheme reassigns it), so a map captured at import would freeze the
// default palette's colours.
function permColor(mode: TuiState["permissionMode"]): string | undefined {
  return mode === "auto-edit" ? color.info : mode === "yolo" ? color.remove : undefined;
}

/** Same names as the mode switch in the other clients. */
const AGENT_LABEL: Record<AgentMode, string> = {
  chat: "Ask",
  plan: "Plan",
  agent: "Agent",
};

function agentColor(mode: AgentMode): string {
  return mode === "plan" ? color.warn : mode === "agent" ? color.accent : color.info;
}

export function StatusBar({
  state,
  statusLineConfig,
  cwd,
  version,
  contextWindow,
  rateLimit,
}: {
  state: TuiState;
  statusLineConfig?: StatusLineConfig;
  cwd: string;
  version: string;
 /** Active model's context window; falls back to the core default when unknown. */
  contextWindow?: number;
 /** Latest provider rate-limit snapshot (fed into the status-line payload). */
  rateLimit?: RateLimitSnapshot;
}): React.ReactElement {
  const [customText, setCustomText] = React.useState<string | null>(null);
  // Git branch for the status-line payload — read fail-soft and cached per cwd
  // (a synchronous `git rev-parse` would be wasteful to run on every re-render).
  const [gitBranch, setGitBranch] = React.useState<string | undefined>(undefined);
  const { stdout } = useStdout();
  const columns = stdout.columns || 80;
  React.useEffect(() => {
    setGitBranch(readGitBranch(cwd));
  }, [cwd]);

 // Render the status line on state changes. A declarative preset renders
 // in-process (synchronous); a custom script is spawned (debounced).
  React.useEffect(() => {
    if (!statusLineConfig) return;
    const totalInput = state.usage.input + (state.usage.cacheRead ?? 0);
    const totalOutput = state.usage.output;
    const windowSize = contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
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
      gitBranch,
      rateLimit,
    });
    if (statusLineConfig.type === "preset") {
      setCustomText(renderPresetStatusLine(statusLineConfig, payload));
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      runStatusLine(statusLineConfig, payload, { cwd }).then((r) => {
        if (!cancelled && r.ok) setCustomText(r.text);
      });
    }, statusLineConfig.updateIntervalMs ?? 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state.model, state.sessionId, state.usage, statusLineConfig, cwd, version, contextWindow, gitBranch, rateLimit]);

 // Rendered status line: a preset's text or a script's stdout (ANSI preserved).
  if (statusLineConfig && customText !== null) {
    return (
      <Box paddingX={(statusLineConfig.padding ?? 0) + 1}>
        <Text>{customText}</Text>
      </Box>
    );
  }

  const sid = state.sessionId !== undefined ? (state.sessionId.split("_").pop() ?? state.sessionId).slice(0, 8) : undefined;
  const total =
    state.usage.input +
    state.usage.output +
    (state.usage.cacheRead ?? 0) +
    (state.usage.cacheWrite ?? 0);

  // Segments are added by priority until the line no longer fits. A status line
  // that wraps is not merely ugly: Ink erases the previous frame by line count,
  // so one extra wrapped line leaves stale text interleaved with the new frame.
  const leftCandidates: Seg[] = [
    { text: `${glyph.running} ${AGENT_LABEL[state.agentMode]}`, color: agentColor(state.agentMode), bold: true },
    {
      text: state.permissionMode,
      ...(permColor(state.permissionMode) ? { color: permColor(state.permissionMode) } : {}),
      ...(state.permissionMode === "ask" ? { dim: true } : {}),
    },
    // Drop the provider prefix first: the model name is the part being read.
    { text: state.model ?? "model unset", dim: true },
  ];
  const tb = state.turnBudget;
  const ceiling =
    tb === undefined
      ? null
      : tb.windDownAt !== null && tb.maxTurns !== null
        ? Math.min(tb.windDownAt, tb.maxTurns)
        : (tb.windDownAt ?? tb.maxTurns);
  if (tb && ceiling !== null) {
    leftCandidates.push({
      text: `turn ${tb.turn + 1}/${ceiling}`,
      color: tb.warning ? color.warn : color.faint,
    });
  }

  const rightCandidates: Seg[] = [
    { text: `${formatTokens(total)} tokens`, color: color.faint },
  ];
  if (state.usage.costUSD !== undefined) {
    rightCandidates.push({ text: `$${state.usage.costUSD.toFixed(4)}`, color: color.faint });
  }
  if (sid) rightCandidates.push({ text: sid, color: color.faint });

  const avail = Math.max(16, columns - 2);
  const GAP = 2;
  const left: Seg[] = [];
  for (const seg of leftCandidates) {
    const next = [...left, seg];
    // Always keep the model name out of the way of the two mandatory segments.
    if (runWidth(next) + runWidth(rightCandidates.slice(0, 1)) + GAP > avail) break;
    left.push(seg);
  }
  const right: Seg[] = [];
  for (const seg of rightCandidates) {
    const next = [...right, seg];
    if (runWidth(left) + runWidth(next) + GAP > avail) break;
    right.push(seg);
  }

  const renderRun = (segs: readonly Seg[], keyPrefix: string): React.ReactElement[] =>
    segs.flatMap((s, i) => {
      const sep = i === 0 ? [] : [<Text key={`${keyPrefix}-sep${i}`} color={color.faint}>{DOT}</Text>];
      return [
        ...sep,
        <Text
          key={`${keyPrefix}-${i}`}
          wrap="truncate-end"
          {...(s.color ? { color: s.color } : {})}
          {...(s.dim ? { dimColor: true } : {})}
          {...(s.bold ? { bold: true } : {})}
        >
          {s.text}
        </Text>,
      ];
    });

  return (
    <Box paddingX={1} width="100%" height={1}>
      {renderRun(left, "l")}
      <Box flexGrow={1} />
      {renderRun(right, "r")}
    </Box>
  );
}
