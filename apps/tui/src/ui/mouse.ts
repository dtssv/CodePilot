/**
 * Terminal mouse support for an Ink app.
 *
 * Ink 5 has no mouse handling of its own, so this module does three things:
 *  - parses SGR (1006) and X10 mouse reports out of the raw stdin byte stream,
 *  - republishes them as {@link TermMouseEvent} to whoever subscribes,
 *  - enables/disables the terminal mouse modes.
 *
 * Coordinates are 0-based cells, which is what the transcript's hit-testing
 * math works in.
 */
import { PassThrough } from "node:stream";

export type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "none";

export interface TermMouseEvent {
  /** 0-based column. */
  x: number;
  /** 0-based row. */
  y: number;
  button: MouseButton;
  action: "press" | "release" | "move";
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Enable button events + drag reporting, and SGR extended coordinates. */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
/** Restore the terminal on exit — leaving 1006 on corrupts the shell prompt. */
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";

const listeners = new Set<(e: TermMouseEvent) => void>();

/** Subscribe to parsed mouse events. Returns an unsubscribe function. */
export function onTermMouse(fn: (e: TermMouseEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(e: TermMouseEvent): void {
  for (const fn of listeners) fn(e);
}

function buttonOf(btn: number, wheel: boolean): MouseButton {
  if (wheel) return btn === 0 ? "wheelUp" : "wheelDown";
  if (btn === 0) return "left";
  if (btn === 1) return "middle";
  if (btn === 2) return "right";
  return "none";
}

/** SGR report: `ESC [ < b ; x ; y (M|m)`. `m` marks release. */
function sgrEvent(code: number, x: number, y: number, press: boolean): TermMouseEvent {
  const motion = (code & 32) !== 0;
  return {
    x: x - 1,
    y: y - 1,
    button: buttonOf(code & 0b11, (code & 64) !== 0),
    action: !press ? "release" : motion ? "move" : "press",
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

/** X10 report: `ESC [ M` followed by three bytes offset by 32. */
function x10Event(code: number, x: number, y: number): TermMouseEvent | undefined {
  const motion = (code & 32) !== 0;
  const button = buttonOf(code & 0b11, (code & 64) !== 0);
  if (button === "none" && !motion) return undefined;
  return {
    x: x - 1,
    y: y - 1,
    button,
    action: motion ? "move" : "press",
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

// `g` flag: replace() walks every report in the chunk.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC sequences
const SGR_RE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC sequences
const X10_RE = /\u001b\[M([\s\S]{3})/g;

/**
 * Split mouse reports out of a raw stdin chunk.
 *
 * Returns the remaining text (everything that is not a mouse report) plus the
 * parsed events. A report may be split across reads — feed the tail from
 * {@link incompleteMouseTail} back in on the next chunk.
 */
export function parseMouseSequences(input: string): { text: string; events: TermMouseEvent[] } {
  const events: TermMouseEvent[] = [];
  let text = input.replace(SGR_RE, (_m, b: string, x: string, y: string, kind: string) => {
    events.push(sgrEvent(Number(b), Number(x), Number(y), kind === "M"));
    return "";
  });
  text = text.replace(X10_RE, (_m, three: string) => {
    const e = x10Event(three.charCodeAt(0) - 32, three.charCodeAt(1) - 32, three.charCodeAt(2) - 32);
    if (e) events.push(e);
    return "";
  });
  return { text, events };
}

/**
 * Trailing bytes that may start a mouse report and so must be held back until
 * the next chunk arrives. Everything else is left to Ink's key parser.
 */
export function incompleteMouseTail(input: string): string {
  const open = input.lastIndexOf("\u001b[");
  if (open === -1) return "";
  const tail = input.slice(open);
  SGR_RE.lastIndex = 0;
  if (SGR_RE.test(tail)) return "";
  SGR_RE.lastIndex = 0;
  // X10 needs exactly three bytes after "\u001b[M".
  if (tail.startsWith("\u001b[M")) return tail.length < 6 ? tail : "";
  return tail.startsWith("\u001b[<") ? tail : "";
}

export interface MouseStdin {
  /** Filtered stream for Ink to drive its key parser from. */
  stdin: NodeJS.ReadStream;
  dispose(): void;
}

/**
 * Wrap a TTY stdin so mouse reports are consumed here and never reach Ink.
 *
 * Ink reads from the returned stream (readable/read, as usual); we pump the
 * real one and forward everything that is not a mouse report. The raw-mode /
 * ref calls Ink makes are proxied straight through so its tedium is unchanged.
 */
export function createMouseStdin(real: NodeJS.ReadStream): MouseStdin {
  const stream = new PassThrough();
  const out = stream as unknown as NodeJS.ReadStream;
  // Ink calls these on whatever we hand it; proxy to the real TTY so raw mode
  // and refcounting behave exactly as before.
  const raw = real as unknown as {
    setRawMode?: (mode: boolean) => unknown;
    ref?: () => void;
    unref?: () => void;
  };
  Object.assign(stream, {
    isTTY: real.isTTY,
    setRawMode: (mode: boolean): NodeJS.ReadStream => {
      raw.setRawMode?.(mode);
      return out;
    },
    ref: (): void => raw.ref?.(),
    unref: (): void => raw.unref?.(),
  });

  let held = "";
  const onData = (chunk: Buffer | string): void => {
    const raw = held + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    held = "";
    const tail = incompleteMouseTail(raw);
    if (tail) held = tail;
    const complete = tail ? raw.slice(0, raw.length - tail.length) : raw;
    if (complete === "") return;
    const { text, events } = parseMouseSequences(complete);
    for (const e of events) emit(e);
    if (text !== "") out.write(text);
  };

  real.on("data", onData);
  return {
    stdin: out,
    dispose(): void {
      real.off("data", onData);
      out.end();
    },
  };
}
