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
 * 3 / p → always allow + remember in project config · 4 / n / Esc → deny ·
 * 5 / f → deny with feedback (type a correction the model sees instead of a
 * bare "denied") · 6 / s → deny & stop (refuse this call and end the turn) ·
 * ↑↓ + ↵ for mouse-free selection.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionResolution } from "@codepilot/core";
import { CATEGORY_VERB, changeCounts, color, glyph, oneLine, toolCategory, toolTarget } from "./theme.js";
import { isEscape } from "./keys.js";

export interface PermissionPromptProps {
  toolName: string;
  input: unknown;
  reason: string;
  onDecide: (resolution: PermissionResolution) => void;
}

type OptionAction = "allow" | "always" | "always-project" | "deny" | "deny-feedback" | "abort";
const OPTIONS: { label: string; keyHint: string; action: OptionAction; hint: string }[] = [
  { label: "Allow once", keyHint: "1/y", action: "allow", hint: "Approve this invocation only." },
  { label: "Always allow", keyHint: "2/a", action: "always", hint: "Approve matching calls (e.g. same command prefix) for this session." },
  { label: "Always (project)", keyHint: "3/p", action: "always-project", hint: "Also save the rule to this project's config for future sessions." },
  { label: "Deny", keyHint: "4/n", action: "deny", hint: "Reject this invocation." },
  { label: "Deny w/ feedback", keyHint: "5/f", action: "deny-feedback", hint: "Reject and tell the model what to do instead." },
  { label: "Deny & stop", keyHint: "6/s", action: "abort", hint: "Reject this call and end the whole turn." },
];

export function PermissionPrompt(props: PermissionPromptProps): React.ReactElement {
  const { toolName, input, reason, onDecide } = props;
  const [idx, setIdx] = React.useState(0);
  // When true, the prompt switches to a one-line feedback editor; Enter submits
  // the typed correction as a decline-with-feedback, Esc cancels back to the
  // option list.
  const [feedbackMode, setFeedbackMode] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");

  const act = React.useCallback(
    (action: OptionAction) => {
      if (action === "deny-feedback") {
        setFeedbackMode(true);
        return;
      }
      if (action === "abort") {
        onDecide({ decision: "abort" });
        return;
      }
      onDecide(action);
    },
    [onDecide],
  );

  useInput(
    (ch, key) => {
      if (feedbackMode) {
        if (key.return) {
          const text = feedback.trim();
          onDecide(text.length > 0 ? { decision: "deny", feedback: text } : "deny");
        } else if (isEscape(ch, key)) {
          setFeedbackMode(false);
          setFeedback("");
        } else if (key.backspace || key.delete) {
          setFeedback((s) => s.slice(0, -1));
        } else if (ch && !key.ctrl && !key.meta) {
          setFeedback((s) => s + ch);
        }
        return;
      }
      if (key.upArrow) setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % OPTIONS.length);
      else if (key.return) act(OPTIONS[idx]!.action);
      else if (isEscape(ch, key)) onDecide("deny");
      else if (ch === "1" || ch === "y" || ch === "Y") onDecide("allow");
      else if (ch === "2" || ch === "a" || ch === "A") onDecide("always");
      else if (ch === "3" || ch === "p" || ch === "P") onDecide("always-project");
      else if (ch === "4" || ch === "n" || ch === "N") onDecide("deny");
      else if (ch === "5" || ch === "f" || ch === "F") act("deny-feedback");
      else if (ch === "6" || ch === "s" || ch === "S") onDecide({ decision: "abort" });
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

      {feedbackMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color.warn}>Deny and tell the model what to do instead:</Text>
          <Box borderStyle="single" borderColor={color.edge} paddingX={1} marginTop={1}>
            <Text>
              {feedback.length > 0 ? feedback : <Text color={color.faint}>type a correction…</Text>}
              <Text color={color.accent}>▌</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={color.faint}>↵ send feedback {glyph.dot} esc cancel</Text>
          </Box>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {OPTIONS.map((opt, i) => {
              const selected = i === idx;
              return (
                <Text key={opt.action}>
                  <Text color={selected ? color.accent : color.faint}>{selected ? "▸ " : "  "}</Text>
                  <Text bold={selected} color={selected ? color.accent : undefined}>
                    {opt.label.padEnd(16)}
                  </Text>
                  <Text color={color.info}> {opt.keyHint.padEnd(4)}</Text>
                  <Text color={color.faint}>{opt.hint}</Text>
                </Text>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text color={color.faint}>
              ↑↓ select {glyph.dot} ↵ confirm {glyph.dot} 1/y once {glyph.dot} 2/a always {glyph.dot} 3/p project {glyph.dot} 4/n deny {glyph.dot} 5/f deny+feedback {glyph.dot} 6/s deny+stop
            </Text>
          </Box>
        </>
      )}
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
