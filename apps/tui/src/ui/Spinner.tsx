/**
 * Tiny self-contained spinner — no external dep, just a stateful counter.
 */
import React from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
  /** Label shown after the spinner glyph. */
  label?: string;
  /** Override the color. */
  color?: string;
}

export function Spinner({ label, color = "cyan" }: SpinnerProps): React.ReactElement {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={color}>
      {FRAMES[idx]} {label ?? ""}
    </Text>
  );
}