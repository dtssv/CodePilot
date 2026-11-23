/**
 * Ephemeral interaction state — what the user has opened, focused, scrolled to,
 * and which sub-agent they drilled into.
 *
 * Kept out of `TuiState` on purpose: that state mirrors the session event log and
 * is what gets replayed; this state belongs to the window and dies with it. Every
 * transition is a pure function so it can be unit-tested without Ink.
 */

export interface InteractionState {
  /** Row keys the user explicitly opened. */
  expanded: ReadonlySet<string>;
  /** Row keys the user explicitly closed (overrides a row that defaults open). */
  collapsed: ReadonlySet<string>;
  /** Index into the entry list, -1 when the prompt has the keyboard. */
  focus: number;
  /** Lines scrolled up from the live edge. 0 follows new output. */
  scroll: number;
  /** Sub-agent transcript currently open. */
  viewing?: { key: string; run: number };
}

export type InteractionAction =
  | { type: "toggle"; key: string; open: boolean }
  | { type: "focus"; index: number }
  | { type: "scroll"; delta: number; max: number }
  | { type: "scroll-to"; value: number }
  | { type: "enter"; key: string; run: number }
  | { type: "run"; delta: number; count: number }
  | { type: "back" }
  | { type: "reset-scroll" };

export const initialInteraction: InteractionState = {
  expanded: new Set<string>(),
  collapsed: new Set<string>(),
  focus: -1,
  scroll: 0,
};

function withMembership(set: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> {
  if (set.has(key) === present) return set;
  const next = new Set(set);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

function wrap(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function interactionReducer(
  state: InteractionState,
  action: InteractionAction,
): InteractionState {
  switch (action.type) {
    case "toggle": {
      // The caller passes how the row currently renders, so a row that defaults
      // open closes on the first press instead of no-oping.
      if (action.open) {
        return {
          ...state,
          expanded: withMembership(state.expanded, action.key, false),
          collapsed: withMembership(state.collapsed, action.key, true),
        };
      }
      return {
        ...state,
        expanded: withMembership(state.expanded, action.key, true),
        collapsed: withMembership(state.collapsed, action.key, false),
      };
    }
    case "focus":
      return { ...state, focus: action.index };
    case "scroll":
      return { ...state, scroll: Math.max(0, Math.min(action.max, state.scroll + action.delta)) };
    case "scroll-to":
      return { ...state, scroll: Math.max(0, action.value) };
    case "reset-scroll":
      return { ...state, scroll: 0 };
    case "enter":
      return { ...state, viewing: { key: action.key, run: action.run }, scroll: 0, focus: -1 };
    case "run": {
      if (!state.viewing) return state;
      const run = wrap(state.viewing.run + action.delta, action.count);
      return { ...state, viewing: { ...state.viewing, run } };
    }
    case "back":
      return { ...state, viewing: undefined, scroll: 0, focus: -1 };
  }
}

/** Whether a collapsible row should render open. */
export function isOpen(state: InteractionState, key: string, openByDefault = false): boolean {
  if (state.collapsed.has(key)) return false;
  if (state.expanded.has(key)) return true;
  return openByDefault;
}
