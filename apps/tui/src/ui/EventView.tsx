/**
 * EventView — renders a single Row from TuiState.
 *
 * This is presentation-only; all state mutation lives in `state.ts`.
 */
import React from "react";
import { Box, Text } from "ink";
import { Markdown } from "./Markdown.js";
import { DiffText } from "./DiffText.js";
import { Spinner } from "./Spinner.js";
import type { Row, ToolRow } from "./state.js";

const RESULT_COLLAPSE_THRESHOLD = 400;

function ToolBlock({ tool }: { tool: ToolRow }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const resultText = tool.resultText ?? "";
  const isError = tool.resultIsError === true;
  const longResult = resultText.length > RESULT_COLLAPSE_THRESHOLD;
  const shown = longResult && !expanded ? resultText.slice(0, RESULT_COLLAPSE_THRESHOLD) + "\n…" : resultText;

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1} borderStyle="round" borderColor={isError ? "red" : "gray"}>
      <Box>
        {tool.status === "running" ? (
          <Spinner label={`running ${tool.name}`} color="yellow" />
        ) : isError ? (
          <Text color="red">✗ {tool.name} (error)</Text>
        ) : (
          <Text color="green">✓ {tool.name}</Text>
        )}
      </Box>
      {tool.inputSummary !== "" ? (
        <Text dimColor>  args: {tool.inputSummary}</Text>
      ) : null}
      {resultText !== "" ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text dimColor>result{longResult ? ` (${resultText.length} chars` + (expanded ? "" : ", truncated") + ")" : ""}:</Text>
            {longResult ? (
              <Text color="cyan" underline>
                {" "}
                {expanded ? "collapse" : "expand"}
              </Text>
            ) : null}
          </Box>
          <DiffText dimColor={false} color={isError ? "red" : undefined}>{shown}</DiffText>
        </Box>
      ) : null}
      {tool.artifactRef !== undefined ? (
        <Text dimColor>artifact: {tool.artifactRef}</Text>
      ) : null}
      {longResult ? (
        <Text dimColor>  (press to {expanded ? "collapse" : "expand"})</Text>
      ) : null}
      {/* Click-to-toggle: detect clicks via Ink's input is awkward; rely on user
          typing nothing here. The "expand/collapse" hint is informational.
          A future improvement could bind a key. */}
      <ExpandHandle onClick={() => setExpanded((v) => !v)} enabled={longResult} />
    </Box>
  );
}

/**
 * ExpandHandle: listens for a printable 'e' to toggle expansion.
 * We can't bind a real click in Ink, so we listen for a key the user can press
 * after expanding/collapsing. Keep it discoverable via the hint above.
 */
function ExpandHandle({ onClick, enabled }: { onClick: () => void; enabled: boolean }): null {
  React.useEffect(() => {
    if (!enabled) return;
    const handler = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (s === "e" || s === "E") onClick();
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, [enabled, onClick]);
  return null;
}

function PlanBlock({ plan }: { plan: import("@codepilot/core").PlanStep[] }): React.ReactElement {
  const symbol = (s: import("@codepilot/core").PlanStep["status"]): string => {
    switch (s) {
      case "completed":
        return "✓";
      case "in_progress":
        return "▶";
      case "blocked":
        return "✗";
      default:
        return "·";
    }
  };
  const color = (s: import("@codepilot/core").PlanStep["status"]): string => {
    switch (s) {
      case "completed":
        return "green";
      case "in_progress":
        return "cyan";
      case "blocked":
        return "red";
      default:
        return "gray";
    }
  };
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      <Text bold>Plan</Text>
      {plan.map((step) => (
        <Text key={step.id} color={color(step.status)}>
          {` ${symbol(step.status)} `} {step.title}
        </Text>
      ))}
    </Box>
  );
}

function UsageBlock({ usage }: { usage: import("@codepilot/core").UsageInfo }): React.ReactElement {
  const parts: string[] = [
    `in=${usage.input}`,
    `out=${usage.output}`,
  ];
  if (usage.cacheRead !== undefined) parts.push(`cacheR=${usage.cacheRead}`);
  if (usage.cacheWrite !== undefined) parts.push(`cacheW=${usage.cacheWrite}`);
  if (usage.costUSD !== undefined) parts.push(`$${usage.costUSD.toFixed(4)}`);
  return (
    <Text dimColor>
      usage {parts.join(" · ")}
    </Text>
  );
}

function UserBlock({ text }: { id: string; text: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="green">you ›</Text>
      <Text>{text || " "}</Text>
    </Box>
  );
}

function AssistantBlock({ msg }: { msg: import("./state.js").MessageRow }): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color="cyan">assistant</Text>
        {msg.model !== undefined ? <Text dimColor> ({msg.model})</Text> : null}
        {msg.streaming ? <Text dimColor> ●streaming</Text> : null}
      </Box>
      {msg.text.length > 0 ? (
        <Markdown dimColor={msg.streaming}>{msg.text}</Markdown>
      ) : msg.streaming ? (
        <Spinner label="thinking…" />
      ) : (
        <Text dimColor>(empty)</Text>
      )}
    </Box>
  );
}

export function RowView({ row }: { row: Row }): React.ReactElement | null {
  switch (row.kind) {
    case "user":
      return <UserBlock id={row.id} text={row.text} />;
    case "assistant":
      return <AssistantBlock msg={row.msg} />;
    case "tool":
      return <ToolBlock tool={row.tool} />;
    case "plan":
      return <PlanBlock plan={row.plan} />;
    case "compaction":
      return (
        <Box marginY={1}>
          <Text color="magenta">⟳ compaction: </Text>
          <Text dimColor>{row.summary.slice(0, 200)}{row.summary.length > 200 ? "…" : ""}</Text>
        </Box>
      );
    case "usage":
      return <UsageBlock usage={row.usage} />;
    case "error":
      return (
        <Box marginY={1}>
          <Text color={row.recoverable ? "yellow" : "red"}>
            {row.recoverable ? "⚠ " : "⛔ "}
            {row.message}
          </Text>
        </Box>
      );
    case "system":
      return (
        <Box marginY={1}>
          <Text dimColor>· {row.text}</Text>
        </Box>
      );
  }
}