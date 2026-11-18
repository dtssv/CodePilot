import {
  applyUpdate,
  checkEngineUpdate,
  currentInstalledVersion,
  initProjectGuidance,
  listLanIPv4,
} from "@codepilot/core";
import { assertInitialized, type ServerContext } from "../context.js";
import type { SystemUpdateApplyResult, SystemUpdateCheckResult } from "../wireTypes.js";

export async function handleSystemUpdateCheck(): Promise<SystemUpdateCheckResult> {
  const engine = await checkEngineUpdate({ checkOnly: true });
  if (!engine) {
    return {
      engine: {
        channel: "engine",
        current: currentInstalledVersion(),
        latest: null,
        available: false,
        installRoot: null,
        canAutoApply: false,
      },
    };
  }
  return { engine };
}

export async function handleSystemUpdateApply(): Promise<SystemUpdateApplyResult> {
  const check = await checkEngineUpdate();
  if (!check) {
    return {
      applied: false,
      version: currentInstalledVersion(),
      message: "Update check disabled or failed",
    };
  }
  if (!check.available || !check.latest || !check.tag) {
    return { applied: false, version: check.current, message: "Already up to date" };
  }
  if (!check.canAutoApply || !check.installRoot) {
    return {
      applied: false,
      version: check.current,
      message: "Cannot auto-apply here (not a ~/.codepilot prefix install). Run: codepilot update",
    };
  }
  const version = await applyUpdate({
    current: check.current,
    latest: check.latest,
    tag: check.tag,
    available: true,
    installRoot: check.installRoot,
  });
  return {
    applied: true,
    version,
    message: "Updated. Restart CodePilot to load the new engine.",
  };
}

export function handleSystemLanIps(): { lanIps: string[]; bindHostHint: string } {
  return {
    lanIps: listLanIPv4(),
    bindHostHint: "0.0.0.0",
  };
}

export async function handleWorkspaceInit(
  ctx: ServerContext,
  params: { force?: boolean; filename?: "AGENTS.md" | "CODEPILOT.md" },
): Promise<{ path: string; created: boolean; skipped: boolean }> {
  assertInitialized(ctx);
  return initProjectGuidance(ctx.defaultCwd, {
    force: params?.force === true,
    filename: params?.filename,
  });
}