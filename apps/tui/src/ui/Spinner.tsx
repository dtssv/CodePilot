/**
 * Tiny self-contained spinner — no external dep, just a stateful counter.
 */
import React from "react";
import { Text } from "ink";
import { color as palette } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
 /** Label shown after the spinner glyph. */
  label?: string;
 /** Override the color. */
  color?: string;
 /** Epoch ms the current phase started; appends a live elapsed counter. */
  since?: number;
}

export function Spinner({ label, color = palette.accent, since }: SpinnerProps): React.ReactElement {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  const elapsed = since !== undefined ? ` · ${Math.max(0, Math.round((Date.now() - since) / 1000))}s` : "";
  return (
    <Text color={color}>
      {FRAMES[idx]} {label ?? ""}
      {elapsed}
    </Text>
  );
}