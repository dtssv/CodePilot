/**
 * Permission confirmation dialog.
 *
 * Shows enough detail to approve confidently without leaving the terminal:
 * - bash: the full command (multi-line, wrapped) plus cwd
 * - write: file path + a preview of the content being written
 * - edit: file path + a compact before→after diff
 * - anything: the formatted target line
 *
 * Keys: 1 / y → allow once · 2 / a → always allow (this session) ·
 * 3 / n / Esc → deny · ↑↓ + ↵ for mouse-free selection.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "@codepilot/core";
import { CATEGORY_VERB, changeCounts, color, glyph, oneLine, toolCategory, toolTarget } from "./theme.js";

export interface PermissionPromptProps {
  toolName: string;
  input: unknown;
  reason: string;
  onDecide: (decision: PermissionDecision) => void;
}

const OPTIONS: { label: string; keyHint: string; decision: PermissionDecision; hint: string }[] = [
  { label: "Allow once", keyHint: "1/y", decision: "allow", hint: "Approve this invocation only." },
  { label: "Always allow", keyHint: "2/a", decision: "always", hint: "Approve matching calls (e.g. same command prefix) for this session." },
  { label: "Deny", keyHint: "3/n", decision: "deny", hint: "Reject this invocation." },
];

export function PermissionPrompt(props: PermissionPromptProps): React.ReactElement {
  const { toolName, input, reason, onDecide } = props;
  const [idx, setIdx] = React.useState(0);

  useInput(
    (_input, key) => {
      if (key.upArrow) setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % OPTIONS.length);
      else if (key.return) onDecide(OPTIONS[idx]!.decision);
      else if (key.escape) onDecide("deny");
      else if (_input === "1" || _input === "y" || _input === "Y") onDecide("allow");
      else if (_input === "2" || _input === "a" || _input === "A") onDecide("always");
      else if (_input === "3" || _input === "n" || _input === "N") onDecide("deny");
    },
    { isActive: true },
  );

  const category = toolCategory(toolName);
  const verb = category === "other" ? toolName : CATEGORY_VERB[category];
  const target = toolTarget(input);
  const counts = changeCounts(toolName, input);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.warn} paddingX={1}>
      <Text bold color={color.warn}>
        {glyph.warn} Approval needed
      </Text>
      <Box marginTop={1}>
        <Text color={color.faint}>{verb} </Text>
        <Text bold>{target || toolName}</Text>
        {counts?.added ? <Text color={color.add}> +{counts.added}</Text> : null}
        {counts?.removed ? <Text color={color.remove}> −{counts.removed}</Text> : null}
      </Box>
      {reason ? <Text color={color.faint}>{reason}</Text> : null}

      <DetailPreview toolName={toolName} input={input} />

      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const selected = i === idx;
          return (
            <Text key={opt.decision}>
              <Text color={selected ? color.accent : color.faint}>{selected ? "▸ " : "  "}</Text>
              <Text bold={selected} color={selected ? color.accent : undefined}>
                {opt.label.padEnd(14)}
              </Text>
              <Text color={color.info}> {opt.keyHint.padEnd(4)}</Text>
              <Text color={color.faint}>{opt.hint}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={color.faint}>
          ↑↓ select {glyph.dot} ↵ confirm {glyph.dot} 1/y once {glyph.dot} 2/a always {glyph.dot} 3/n/esc deny
        </Text>
      </Box>
    </Box>
  );
}

/** Tool-specific detail so the user can judge the call without scrolling the
 * transcript back. Kept compact: a few lines, truncated with elision. */
function DetailPreview({ toolName, input }: { toolName: string; input: unknown }): React.ReactElement | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const category = toolCategory(toolName);

  if (category === "bash" && typeof o.command === "string") {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={color.edge} paddingX={1}>
        {o.command.split("\n").slice(0, 6).map((line, i) => (
          <Text key={i} color={color.info}>
            {i === 0 ? "$ " : "  "}
            {line}
          </Text>
        ))}
        {o.command.split("\n").length > 6 ? (
          <Text color={color.faint}>  … {o.command.split("\n").length - 6} more lines</Text>
        ) : null}
      </Box>
    );
  }

  if (category === "write" && typeof o.content === "string") {
    const lines = o.content.replace(/\n$/, "").split("\n");
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={color.edge} paddingX={1}>
        {lines.slice(0, 5).map((line, i) => (
          <Text key={i} color={color.add}>+ {oneLine(line, 100)}</Text>
        ))}
        {lines.length > 5 ? <Text color={color.faint}>  … {lines.length - 5} more lines</Text> : null}
      </Box>
    );
  }

  if (category === "edit") {
    const before = o.search ?? o.old_string ?? o.old_str;
    const after = o.replace ?? o.new_string ?? o.new_str;
    if (typeof before !== "string" && typeof after !== "string") return null;
    const beforeLines = typeof before === "string" ? before.replace(/\n$/, "").split("\n") : [];
    const afterLines = typeof after === "string" ? after.replace(/\n$/, "").split("\n") : [];
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={color.edge} paddingX={1}>
        {beforeLines.slice(0, 3).map((line, i) => (
          <Text key={`r${i}`} color={color.remove}>− {oneLine(line, 100)}</Text>
        ))}
        {beforeLines.length > 3 ? <Text color={color.faint}>  … {beforeLines.length - 3} more removed</Text> : null}
        {afterLines.slice(0, 5).map((line, i) => (
          <Text key={`a${i}`} color={color.add}>+ {oneLine(line, 100)}</Text>
        ))}
        {afterLines.length > 5 ? <Text color={color.faint}>  … {afterLines.length - 5} more added</Text> : null}
      </Box>
    );
  }

  return null;
}
