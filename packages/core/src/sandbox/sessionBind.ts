// Sandbox policy session bind: live mode/status, delivery roots, writable-path
// expansion. Permission preset/rules live in `../permissions/sessionBind.js`.

import { resolve } from "node:path";
import type {
  PermissionDecision,
  PermissionResolution,
  PermissionRequest,
} from "../types.js";
import type { PermissionEngine } from "../permissions/permissions.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { CodepilotConfig } from "../types.js";
import type { PersistentShell } from "./persistentShell.js";
import {
  resolveSandbox,
  detectSandboxBackend,
  buildSandboxUnavailable,
  addWritableRoot,
  isWriteOutsideSandbox,
  type ResolvedSandbox,
  type SandboxBackend,
  type SandboxUnavailable,
} from "./sandbox.js";
import {
  mergeDeliveryRoots,
} from "../workspace/deliveryRoots.js";
import { persistSandboxWritablePath } from "../session/session-helpers.js";

/** Sandbox availability status returned by {@link getSandboxStatus} and
 * {@link setSandboxMode}. When `unavailable` is true the active sandbox
 * mode has no usable OS backend and bash is being refused (fail-closed);
 * `reason` then carries structured, platform-specific install guidance. */
export interface SandboxStatus {
  mode: ResolvedSandbox["mode"];
  unavailable: boolean;
  backend: SandboxBackend;
  reason?: SandboxUnavailable;
}

export type SandboxHost = {
  config: CodepilotConfig;
  sandbox: ResolvedSandbox;
  _sandboxUnavailable: boolean;
  permissions: PermissionEngine;
  persistentShell: PersistentShell | null;
  hooks: HookEngine;
  deliveryRoots: string[];
  cwd: string;
  onPermissionRequest?: (
    req: PermissionRequest,
  ) => Promise<PermissionResolution>;
  steerSystem(text: string): void;
  startPersistentShell(): PersistentShell | null;
  rebuildSystemPrompt(): Promise<void>;
};

/** Current sandbox policy (read-only view for hosts/tests). */
export function getSandbox(host: SandboxHost): ResolvedSandbox {
  return host.sandbox;
}

/** Add a directory as a task delivery root (session-scoped).
 * Mutates the live array in place so mid-turn ToolContext stays current. */
export function addDeliveryRoot(host: SandboxHost, dir: string): void {
  const merged = mergeDeliveryRoots(host.deliveryRoots, [dir]);
  host.deliveryRoots.length = 0;
  host.deliveryRoots.push(...merged);
  // Keep the permission engine's boundary check in sync — a delivery root is
  // part of the in-boundary working set.
  host.permissions.setDeliveryRoots(host.deliveryRoots);
  void host.rebuildSystemPrompt().catch(() => undefined);
}

/** Current delivery roots (copy). */
export function getDeliveryRoots(host: SandboxHost): string[] {
  return [...host.deliveryRoots];
}

/**
 * When the user explicitly names target directories in a prompt, open the OS
 * sandbox for them proactively. For each named dir the sandbox would block:
 *  - `yolo` / `auto-edit` → grant silently (these modes already allow writes);
 *  - otherwise → ask the host once (the same sandbox-expand prompt a blocked
 *    write would raise), and grant on allow/always (persist on "always"). On
 *    deny we leave it blocked — an explicit user decision.
 * The point: the SANDBOX requests the directory's permission, instead of
 * silently blocking the write or forcing the model to negotiate for it.
 */
export async function grantSandboxForMentionedRoots(
  host: SandboxHost,
  dirs: string[],
): Promise<void> {
  if (host.sandbox.mode === "off" || host.sandbox.mode === "read-only") return;
  const mode = host.permissions.getMode();
  for (const raw of dirs) {
    const dir = resolve(host.cwd, raw);
    // Already writable in the jail → nothing to request.
    if (!isWriteOutsideSandbox(dir, host.sandbox, host.cwd)) continue;
    if (mode === "yolo" || mode === "auto-edit") {
      await expandWritablePath(host, dir, { persist: false });
      continue;
    }
    // ask-mode (and plan): let the sandbox request the directory's permission
    // through the host. No handler → leave blocked (a blocked write will
    // still raise the per-write prompt later), never silently widen the jail.
    if (!host.onPermissionRequest) continue;
    let resolution: PermissionResolution;
    try {
      resolution = await host.onPermissionRequest({
        requestId: `sandbox_grant_${Math.random().toString(36).slice(2, 10)}`,
        toolName: "sandbox",
        input: { path: dir },
        reason:
          `You asked to work in “${dir}”, which is outside the sandbox's writable roots. ` +
          `Allow once grants it for this session; Always also saves it to sandbox.writablePaths.`,
        sandboxExpand: { path: dir },
      });
    } catch {
      continue; // host error → leave blocked; per-write prompt still guards
    }
    // Normalize the resolution. A decline-with-feedback object means "don't
    // widen the jail, but the user left a correction" — there is no
    // tool_result to attach it to here (the sandbox grant is pre-emptive, not
    // a tool call), so surface the feedback to the model as a system notice so
    // its next step sees the instruction. A plain deny stays silent.
    const decision: PermissionDecision | "abort" =
      typeof resolution === "string" ? resolution : resolution.decision;
    if (decision === "allow" || decision === "always" || decision === "always-project") {
      await expandWritablePath(host, dir, {
        persist: decision === "always" || decision === "always-project",
      });
    } else if (
      typeof resolution !== "string" &&
      resolution.decision === "deny" &&
      resolution.feedback.trim().length > 0
    ) {
      host.steerSystem(
        `The user declined to extend the sandbox's writable roots to “${dir}” and ` +
          `instructed: ${resolution.feedback.trim()}`,
      );
    }
  }
}

export async function expandWritablePath(
  host: SandboxHost,
  dir: string,
  opts: { persist?: boolean } = {},
): Promise<string> {
  addWritableRoot(host.sandbox, dir);
  host.config = {
    ...host.config,
    sandbox: {
      ...host.config.sandbox,
      mode: host.config.sandbox?.mode ?? host.sandbox.mode,
      writablePaths: [...host.sandbox.writablePaths],
    },
  };
  host.permissions.setSandbox(host.sandbox, host.cwd);
  // The granted folder is now part of the in-boundary working set too (the
  // boundary policy reads it alongside writable roots).
  host.permissions.addWorkingDirectory(dir);
  if (host.persistentShell) {
    try {
      host.persistentShell.close();
    } catch {
      /* ignore */
    }
    host.persistentShell = host.startPersistentShell();
  }
  if (opts.persist) {
    await persistSandboxWritablePath(dir);
  }
  return resolve(dir);
}

/**
 * Hot-apply a new sandbox mode to the LIVE session (the host also persists it
 * to the user config so the next session inherits it). Re-resolves the policy,
 * re-wires the permission engine + command-hook sandbox, recomputes the
 * "no OS backend" availability flag, and restarts the persistent shell so the
 * next bash command runs under the new policy. Mirrors the wiring done once in
 * the constructor (and the restart done by {@link expandWritablePath}), so a
 * mid-session switch cannot leave a stale jail behind.
 *
 * This is deliberately the ONLY mutation entry point for the mode — writes go
 * through the same `resolveSandbox` + `setSandbox` path as startup, so there is
 * no second code path that could drift from the real enforcement.
 */
export function setSandboxMode(
  host: SandboxHost,
  mode: ResolvedSandbox["mode"],
): SandboxStatus {
  // Preserve the operator's other sandbox settings (network/writablePaths/
  // fallback); only the mode changes.
  host.config = {
    ...host.config,
    sandbox: { ...host.config.sandbox, mode },
  };
  host.sandbox = resolveSandbox(host.config.sandbox, host.cwd);
  host._sandboxUnavailable =
    host.sandbox.mode !== "off" &&
    detectSandboxBackend() === "none" &&
    host.sandbox.fallback === "deny";
  host.permissions.setSandbox(host.sandbox, host.cwd);
  if (host.config.hookSandbox) {
    host.hooks.setCommandSandbox(host.sandbox);
  }
  // Restart the persistent shell so the next command is (un)jailed per the new
  // policy. A command already in flight keeps its old shell; the switch takes
  // effect from the next bash call — the honest boundary for a live change.
  if (host.persistentShell) {
    try {
      host.persistentShell.close();
    } catch {
      /* ignore */
    }
    host.persistentShell = host.startPersistentShell();
  }
  return getSandboxStatus(host);
}

/** Sandbox availability status. When `unavailable` is true, bash commands
 * are being refused because sandbox mode is active but no OS backend
 * exists and fallback is "deny". The host should surface this to the
 * user (e.g. a warning banner) — `reason` carries structured, platform
 * specific install guidance when unavailable. */
export function getSandboxStatus(host: SandboxHost): SandboxStatus {
  const backend = detectSandboxBackend();
  return {
    mode: host.sandbox.mode,
    unavailable: host._sandboxUnavailable,
    backend,
    reason: host._sandboxUnavailable ? buildSandboxUnavailable() : undefined,
  };
}
