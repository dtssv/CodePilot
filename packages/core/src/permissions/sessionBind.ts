// Permission mode / preset / saved-rules session bind. Sandbox policy APIs
// live in `../sandbox/sessionBind.js`; {@link setPreset} composes both.

import type {
  PermissionMode,
  PermissionPresetName,
} from "../types.js";
import { PERMISSION_PRESETS } from "../types.js";
import {
  type SandboxHost,
  type SandboxStatus,
  setSandboxMode,
} from "../sandbox/sessionBind.js";

/**
 * Hot-apply a new permission mode to the LIVE session. The engine reads its
 * mode at every preflight, so this takes effect from the next tool call. Also
 * updates `config.permissionMode` so anything that re-derives from config
 * (e.g. a system-prompt rebuild) sees the new posture. Returns the applied
 * mode. This is the permission-side counterpart of {@link setSandboxMode}.
 */
export function setPermissionMode(host: SandboxHost, mode: PermissionMode): PermissionMode {
  host.config = { ...host.config, permissionMode: mode };
  host.permissions.setMode(mode);
  // Refresh volatile `<runtime>permission:` for the next turn.
  void host.rebuildSystemPrompt().catch(() => undefined);
  return mode;
}

/** Active permission mode. */
export function getPermissionMode(host: SandboxHost): PermissionMode {
  return host.permissions.getMode();
}

/**
 * Apply a named permission preset: a single switch that sets BOTH the
 * permission mode and the sandbox mode. Composes the two existing live
 * switches ({@link setPermissionMode} + {@link setSandboxMode}) so a preset
 * can never drift from the real enforcement. Returns the resolved posture.
 * The host is responsible for persisting the choice if it wants it to
 * survive the session (the sandbox half already persists via the
 * `config/setSandbox` RPC path when driven through the server).
 */
export function setPreset(
  host: SandboxHost,
  name: PermissionPresetName,
): {
  preset: PermissionPresetName;
  permissionMode: PermissionMode;
  sandbox: SandboxStatus;
} {
  const spec = PERMISSION_PRESETS[name];
  setPermissionMode(host, spec.permissionMode);
  const sandbox = setSandboxMode(host, spec.sandbox);
  return { preset: name, permissionMode: spec.permissionMode, sandbox };
}

/** Active permission rules (session + config), for UI display. */
export function getPermissionRules(host: SandboxHost) {
  return host.permissions.rules();
}

/** True when the active model is high-risk and persisted allow rules are being
 * ignored during matching (deny / ask + floors still apply). Lets a UI surface
 * a "saved allow rules bypassed" badge so the stricter posture is visible. */
export function isIgnoringPersistedAllows(host: SandboxHost): boolean {
  return host.permissions.isIgnoringPersistedAllows();
}

/** Persisted permission rules by scope (repo / user), for the saved-rule
 * management surface. Reads the config files directly — the on-disk source of
 * truth for durable rules — not the in-memory merged set. */
export async function listSavedPermissionRules(
  host: SandboxHost,
  scope: "repo" | "user" = "repo",
) {
  const { listPersistedRules } = await import("./permissions.js");
  return listPersistedRules(host.cwd, scope);
}

/** Add a persisted permission rule in a scope and hot-apply it to the live
 * engine (so it takes effect this session and unlocks any pending prompt it
 * covers). Returns the config path written. */
export async function addSavedPermissionRule(
  host: SandboxHost,
  rule: string,
  effect: "allow" | "ask" | "deny",
  scope: "repo" | "user" = "repo",
): Promise<string> {
  const { persistRule } = await import("./permissions.js");
  const path = await persistRule(host.cwd, rule, effect, scope);
  host.permissions.addConfigRule(rule, effect);
  return path;
}

/** Remove a persisted permission rule from a scope and hot-apply the removal
 * to the live engine. Returns true when a rule was removed. */
export async function removeSavedPermissionRule(
  host: SandboxHost,
  rule: string,
  effect: "allow" | "ask" | "deny",
  scope: "repo" | "user" = "repo",
): Promise<boolean> {
  const { removePersistedRule } = await import("./permissions.js");
  const removed = await removePersistedRule(host.cwd, rule, effect, scope);
  if (removed) host.permissions.removeConfigRule(rule, effect);
  return removed;
}
