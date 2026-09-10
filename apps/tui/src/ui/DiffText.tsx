/**
 * DiffText — renders tool-result text with diff-aware coloring.
 *
 * When the input looks like a unified diff (lines starting with `+`, `-`,
 * `@@`, or `---`/`+++` headers), each line is colored:
 *   - `+` lines → green
 *   - `-` lines → red
 *   - `@@` hunk headers → cyan, dim
 *   - `---`/`+++` file headers → magenta, bold
 *   - context lines → default
 *
 * Non-diff text is rendered verbatim (no per-line coloring), so this is a
 * safe drop-in for the plain `<Text>` that previously rendered results.
 */
import React from "react";
import { Box, Text } from "ink";

export interface DiffTextProps {
  children: string;
  /** When true, the whole block is dimmed (e.g. streaming). */
  dimColor?: boolean;
  /** Color override for non-diff text (e.g. "red" for errors). */
  color?: string;
}

/** Heuristic: treat as a diff if at least 2 lines start with +/- and there's
 *  a hunk header or file header. This avoids false positives on prose that
 *  happens to start a line with "+". */
function looksLikeDiff(text: string): boolean {
  const lines = text.split("\n");
  let plus = 0;
  let minus = 0;
  let hunkOrFile = false;
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---")) hunkOrFile = true;
    if (l.startsWith("@@")) hunkOrFile = true;
    if (l.startsWith("+") && !l.startsWith("+++")) plus++;
    if (l.startsWith("-") && !l.startsWith("---")) minus++;
  }
  return hunkOrFile && (plus + minus) >= 2;
}

/** Also detect apply_patch format (`*** Update File:`, etc.). */
function looksLikeApplyPatch(text: string): boolean {
  return (
    text.includes("*** Begin Patch") ||
    text.includes("*** Update File:") ||
    text.includes("*** Add File:")
  );
}

export function DiffText({ children, dimColor, color }: DiffTextProps): React.ReactElement {
  const isDiff = looksLikeDiff(children) || looksLikeApplyPatch(children);
  if (!isDiff) {
    return (
      <Text dimColor={dimColor} color={color}>
        {children}
      </Text>
    );
  }
  const lines = children.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const key = `d-${i}`;
        if (line.startsWith("+++") || line.startsWith("---")) {
          return (
            <Text key={key} bold color="magenta" dimColor={dimColor}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={key} color="cyan" dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("*** ")) {
          // apply_patch directives
          return (
            <Text key={key} bold color="magenta" dimColor={dimColor}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("+")) {
          return (
            <Text key={key} color="green" dimColor={dimColor}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Text key={key} color="red" dimColor={dimColor}>
              {line}
            </Text>
          );
        }
        return (
          <Text key={key} dimColor={dimColor} color={color}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
