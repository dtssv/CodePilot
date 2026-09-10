/**
 * SessionController + PermissionBridge — narrow façades exposed to the TUI.
 *
 * The TUI doesn't talk to `@codepilot/core` directly; instead it goes through
 * these objects. That keeps:
 *  - the TUI component tree pure (no `await import` inside render),
 *  - a single seam for substituting a mock backend during UI development,
 *  - slash commands self-contained (no scattered core access),
 *  - permission flow decoupled from React state.
 */
import type {
  CodepilotConfig,
  GoalRunResult,
  PermissionDecision,
  PermissionMode,
  QuestionAnswers,
  QuestionRequest,
  Session,
  SessionSummary,
} from "@codepilot/core";

export interface CoreSessionController {
  kind: "core";
  core: typeof import("@codepilot/core");
  cwd: string;
  /** Set after a /resume, otherwise undefined. */
  resumeId?: string;
}

export interface MockSessionController {
  kind: "mock";
  listSessions(): Promise<SessionSummary[]>;
  runGoal(opts: { objective: string; cwd: string }): Promise<GoalRunResult>;
}

export type SessionController = CoreSessionController | MockSessionController;

/**
 * Bridge between the React UI and the (possibly async) permission callback
 * that core sees. Implementation in cli.tsx wires
 *   onPermissionRequest = (req) => bridge.waitDecision(req)
 * The UI calls `bridge.resolve(requestId, decision)` when the user picks.
 */
export interface PermissionBridge {
  /** UI subscribes to know when a request is waiting for the user. */
  onPending(listener: (req: PendingPermission) => void): () => void;
  /** Core awaits this; resolved when the UI calls `resolve`. */
  waitDecision(req: PendingPermission): Promise<PermissionDecision>;
  /** UI calls this when the user decides. */
  resolve(requestId: string, decision: PermissionDecision): void;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

/**
 * Bridge between the React UI and the (async) onAskUser callback that core
 * sees. Implementation in cli.tsx wires
 *   onAskUser = (req) => bridge.waitAnswers(req)
 * The UI calls `bridge.resolve(requestId, answers)` when the user finishes
 * answering all questions in the request.
 */
export interface QuestionBridge {
  /** UI subscribes to know when a question request is waiting for the user. */
  onPending(listener: (req: QuestionRequest) => void): () => void;
  /** Core awaits this; resolved when the UI calls `resolve`. */
  waitAnswers(req: QuestionRequest): Promise<QuestionAnswers>;
  /** UI calls this when the user has answered every question. */
  resolve(requestId: string, answers: QuestionAnswers): void;
}

/**
 * Concrete question bridge. Mirrors createPermissionBridge: each pending
 * request gets its own waiter entry keyed by requestId.
 */
export function createQuestionBridge(): QuestionBridge {
  const waiters = new Map<
    string,
    { resolve: (a: QuestionAnswers) => void; reject: (e: Error) => void }
  >();
  const listeners = new Set<(req: QuestionRequest) => void>();

  return {
    onPending(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitAnswers(req) {
      return new Promise<QuestionAnswers>((resolve, reject) => {
        waiters.set(req.requestId, { resolve, reject });
        for (const l of listeners) l(req);
      });
    },
    resolve(requestId, answers) {
      const w = waiters.get(requestId);
      if (w === undefined) {
        // Stale id; ignore.
        return;
      }
      waiters.delete(requestId);
      w.resolve(answers);
    },
  };
}

export interface ActiveSession {
  session: Session;
  model: string | undefined;
  permissionMode: PermissionMode;
  reset(opts: {
    cwd?: string;
    resumeId?: string;
    model?: string;
    permissionMode?: PermissionMode;
    config?: CodepilotConfig;
  }): Promise<ActiveSession>;
  listSessions(): Promise<SessionSummary[]>;
  onPermissionRequest(req: PendingPermission): Promise<PermissionDecision>;
}

/**
 * Concrete permission bridge. Thread-safe-ish: each pending request gets its
 * own entry; resolve() unblocks exactly the waiter for that requestId.
 */
export function createPermissionBridge(): PermissionBridge {
  const waiters = new Map<
    string,
    { resolve: (d: PermissionDecision) => void; reject: (e: Error) => void }
  >();
  const listeners = new Set<(req: PendingPermission) => void>();

  return {
    onPending(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitDecision(req) {
      return new Promise<PermissionDecision>((resolve, reject) => {
        waiters.set(req.requestId, { resolve, reject });
        for (const l of listeners) l(req);
      });
    },
    resolve(requestId, decision) {
      const w = waiters.get(requestId);
      if (w === undefined) {
        // No waiter: caller passed a stale id; ignore.
        return;
      }
      waiters.delete(requestId);
      w.resolve(decision);
    },
  };
}