/**
 * Permission confirmation dialog.
 *
 * Shows the tool name, reason, and a three-way arrow-key selector:
 *   - Allow once
 *   - Always allow this tool
 *   - Deny
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "@codepilot/core";
import { summarizeInput } from "./state.js";

export interface PermissionPromptProps {
  toolName: string;
  input: unknown;
  reason: string;
  onDecide: (decision: PermissionDecision) => void;
}

const OPTIONS: { label: string; decision: PermissionDecision; hint: string }[] = [
  { label: "Allow once", decision: "allow", hint: "Approve this invocation only." },
  { label: "Always allow", decision: "always", hint: "Approve this tool for the rest of the session." },
  { label: "Deny", decision: "deny", hint: "Reject this invocation." },
];

export function PermissionPrompt(props: PermissionPromptProps): React.ReactElement {
  const { toolName, input, reason, onDecide } = props;
  const [idx, setIdx] = React.useState(0);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      } else if (key.downArrow) {
        setIdx((i) => (i + 1) % OPTIONS.length);
      } else if (key.return) {
        const opt = OPTIONS[idx]!;
        onDecide(opt.decision);
      } else if (key.escape) {
        onDecide("deny");
      } else if (_input === "y" || _input === "Y") {
        onDecide("allow");
      } else if (_input === "a" || _input === "A") {
        onDecide("always");
      } else if (_input === "n" || _input === "N") {
        onDecide("deny");
      }
    },
    { isActive: true },
  );

  const summary = summarizeInput(toolName, input);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ⚠  Permission required
      </Text>
      <Text>
        Tool: <Text bold>{toolName}</Text>
      </Text>
      <Text>
        Why: <Text dimColor>{reason}</Text>
      </Text>
      {summary !== "" ? (
        <Text dimColor>  {summary}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const selected = i === idx;
          return (
            <Text key={opt.decision} inverse={selected}>
              {selected ? "▶ " : "  "}
              {opt.label.padEnd(16)}
              <Text dimColor>{opt.hint}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · Enter confirm · y/a/n shortcut · Esc deny</Text>
      </Box>
    </Box>
  );
}