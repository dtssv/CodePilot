/**
 * Caret parking.
 *
 * A frame is written as a block of text and the cursor is left on the line
 * after it, so everything the terminal anchors to the cursor — IME preedit,
 * candidate popups, screen magnifiers — lands at the bottom-left of the screen
 * instead of inside the prompt. This wraps stdout so that after each frame the
 * cursor is parked on the cell the prompt paints its caret in, and put back on
 * the frame's end before the next frame is written: the log update erases
 * previous lines with relative cursor moves, so it has to find the cursor where
 * it left it.
 *
 * The park position is resolved at write time, after layout, from the element
 * the prompt declares — reading it any earlier would use last frame's geometry.
 */
import { Writable } from "node:stream";

const SAVE = "\u001b7";
const RESTORE = "\u001b8";

/** Cell offsets relative to the declared element, 0-based. */
export interface CaretOffset {
  line: number;
  col: number;
}

/**
 * Reads the caret's position inside the declared element. `width`/`height` are
 * the element's laid-out content box, so a prompt can fold long lines and still
 * report the cell the caret really lands on.
 */
export type CaretLocator = (width: number, height: number) => CaretOffset | null;

interface Region {
  node: { yogaNode?: { getComputedTop(): number; getComputedLeft(): number; getComputedWidth(): number; getComputedHeight(): number }; parentNode?: unknown };
  locate: CaretLocator;
}

let region: Region | null = null;

/** Declare where the next frames should park the cursor. */
export function setCaretRegion(node: Region["node"] | null, locate?: CaretLocator): void {
  region = node && locate ? { node, locate } : null;
}

function originOf(node: Region["node"]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: Region["node"] | undefined = node;
  while (cur?.yogaNode) {
    x += cur.yogaNode.getComputedLeft();
    y += cur.yogaNode.getComputedTop();
    cur = cur.parentNode as Region["node"] | undefined;
  }
  return { x, y };
}

/** Absolute 1-based cell for the declared caret, or null when unmapped. */
function resolve(): CaretOffset | null {
  if (!region) return null;
  const yoga = region.node.yogaNode;
  if (!yoga) return null;
  const inner = region.locate(yoga.getComputedWidth(), yoga.getComputedHeight());
  if (!inner) return null;
  const origin = originOf(region.node);
  return { line: origin.y + inner.line, col: origin.x + inner.col };
}

export interface CaretStdout {
  /** Stream for Ink to write frames to. */
  stdout: NodeJS.WriteStream;
  /** Stop parking and leave the cursor at the frame's end. */
  dispose(): void;
}

/**
 * Wrap `real` so the cursor parks after every frame.
 *
 * The save/restore pair keeps the frame's end implicit, so no line arithmetic is
 * needed when the frame shrinks, wraps, or the terminal scrolls.
 */
export function createCaretStdout(real: NodeJS.WriteStream): CaretStdout {
  let parked = false;

  const out = new Writable({
    write(chunk: Buffer | string, _enc, done): void {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Back to the frame's end first: the frame erases and repaints from there,
      // and a stray write (the console patch) has to see the same cursor.
      if (parked) real.write(RESTORE);
      parked = false;
      real.write(text);
      // Only a frame carries a newline; a bare erase must not trigger a move.
      if (text.includes("\n")) {
        const cell = resolve();
        if (cell) {
          real.write(`${SAVE}\u001b[${Math.max(1, cell.line + 1)};${Math.max(1, cell.col + 1)}H`);
          parked = true;
        }
      }
      done();
    },
  }) as unknown as NodeJS.WriteStream;

  Object.assign(out, { columns: real.columns, rows: real.rows, isTTY: real.isTTY });
  const onResize = (): void => {
    Object.assign(out, { columns: real.columns, rows: real.rows });
    out.emit("resize");
  };
  real.on("resize", onResize);

  return {
    stdout: out,
    dispose(): void {
      real.off("resize", onResize);
      if (parked) real.write(RESTORE);
      parked = false;
      region = null;
    },
  };
}
