/**
 * Plugin (extension) update checks — separate from the engine (~/.codepilot) updater.
 * Compares this VSIX's package.json version to GitHub Releases latest tag.
 */

import * as vscode from "vscode";

const DEFAULT_REPO = "dtssv/CodePilot";
const RELEASES_URL = "https://github.com/dtssv/CodePilot/releases";

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/);
  const pb = normalizeVersion(b).split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface ExtensionUpdateCheck {
  channel: "plugin";
  current: string;
  latest: string | null;
  available: boolean;
  releasesUrl: string;
}

export async function checkExtensionUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtensionUpdateCheck> {
  const repo = process.env.CODEPILOT_REPO ?? DEFAULT_REPO;
  const current = normalizeVersion(currentVersion);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codepilot-vscode",
      },
    });
    if (!res.ok) {
      return { channel: "plugin", current, latest: null, available: false, releasesUrl: RELEASES_URL };
    }
    const json = (await res.json()) as { tag_name?: string };
    const latest = json.tag_name ? normalizeVersion(json.tag_name) : null;
    return {
      channel: "plugin",
      current,
      latest,
      available: latest !== null && compareVersions(latest, current) > 0,
      releasesUrl: RELEASES_URL,
    };
  } catch {
    return { channel: "plugin", current, latest: null, available: false, releasesUrl: RELEASES_URL };
  }
}

/** Notify once if a newer extension release exists. Does not update the engine. */
export async function notifyExtensionUpdateIfAvailable(
  context: vscode.ExtensionContext,
): Promise<void> {
  const current = context.extension.packageJSON.version as string;
  const check = await checkExtensionUpdate(current);
  if (!check.available || !check.latest) return;

  const choice = await vscode.window.showInformationMessage(
    `CodePilot extension update available: ${check.current} → ${check.latest}. Download the .vsix from Releases (engine updates are separate: Settings → Updates, or \`codepilot update\`).`,
    "Open Releases",
  );
  if (choice === "Open Releases") {
    await vscode.env.openExternal(vscode.Uri.parse(check.releasesUrl));
  }
}

export async function runCheckUpdatesCommand(context: vscode.ExtensionContext): Promise<void> {
  const current = context.extension.packageJSON.version as string;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodePilot: checking extension update…" },
    async () => {
      const check = await checkExtensionUpdate(current);
      if (check.available && check.latest) {
        const choice = await vscode.window.showInformationMessage(
          `Extension ${check.current} → ${check.latest} available. Engine updates: use CodePilot Settings → Updates or \`codepilot update\`.`,
          "Open Releases",
        );
        if (choice === "Open Releases") {
          await vscode.env.openExternal(vscode.Uri.parse(check.releasesUrl));
        }
      } else {
        void vscode.window.showInformationMessage(
          `CodePilot extension is up to date (${check.current}). Engine updates are checked separately in Settings → Updates.`,
        );
      }
    },
  );
}
