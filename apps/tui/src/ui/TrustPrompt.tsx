/**
 * First-run folder trust dialog, shown before any session (and therefore any
 * project config, hooks or MCP servers) is loaded for a directory.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import { brand, color, glyph, shortPath } from "./theme.js";
import { isEscape } from "./keys.js";

export function TrustPrompt({
  cwd,
  broad,
  onDecide,
}: {
  cwd: string;
  /** Home directory or filesystem root: trust covers this folder only. */
  broad: boolean;
  onDecide: (trusted: boolean) => void;
}): React.ReactElement {
  const [idx, setIdx] = React.useState(0);
  useInput((ch, key) => {
    if (key.upArrow || key.downArrow || key.tab) setIdx((i) => (i === 0 ? 1 : 0));
    else if (key.return) onDecide(idx === 0);
    else if (ch === "1" || ch === "y" || ch === "Y") onDecide(true);
    else if (ch === "2" || ch === "n" || ch === "N" || isEscape(ch, key) || (key.ctrl && ch === "c")) onDecide(false);
  });
  const options = ["Yes, I trust this folder", "No, exit"];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.warn} paddingX={2} marginY={1}>
      <Text bold>
        <Text color={brand[0]}>{glyph.logo} </Text>
        Do you trust the files in this folder?
      </Text>
      <Box marginTop={1}>
        <Text color={color.accent} bold>
          {shortPath(cwd)}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>CodePilot will read, edit and run files here.</Text>
        <Text color={color.faint}>
          Project files such as .codepilot/config.json, .mcp.json, hooks and AGENTS.md can run commands and steer the
          agent. Only continue if this folder comes from a source you trust.
        </Text>
        {broad ? (
          <Text color={color.warn}>
            {glyph.warn} This is a very broad folder. Trusting it does not cover the projects inside it.
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {options.map((label, i) => (
          <Text key={label} color={i === idx ? color.accent : undefined} bold={i === idx}>
            {i === idx ? "❯ " : "  "}
            {i + 1}. {label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color.faint}>
          ↑↓ select {glyph.dot} ↵ confirm {glyph.dot} esc exit
        </Text>
      </Box>
    </Box>
  );
}
