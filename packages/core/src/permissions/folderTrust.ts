// Workspace-level trust: before an interactive client starts working in a
// directory for the first time, the user confirms they trust its contents
// (project config, hooks, MCP servers and instructions files can all steer the
// agent). A decision is stored per real path in `~/.codepilot/trusted-folders.json`.
//
// Trusting a folder also trusts everything beneath it, EXCEPT when the trusted
// folder is the home directory or the filesystem root: those are too broad to
// cover every project below them, so they only match exactly.
//
// Fail-soft in the I/O sense only: a missing or corrupt store loads as empty
// (nothing trusted yet), never as "everything trusted".

import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";

export interface TrustedFolder {
  path: string;
  trustedAt: string;
}

interface TrustStore {
  version: 1;
  folders: TrustedFolder[];
}

export function defaultFolderTrustPath(home: string = homedir()): string {
  return join(home, ".codepilot", "trusted-folders.json");
}

function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function loadStore(file: string): TrustStore {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TrustStore>;
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders.filter(
          (f): f is TrustedFolder =>
            !!f && typeof f.path === "string" && typeof f.trustedAt === "string",
        )
      : [];
    return { version: 1, folders };
  } catch {
    return { version: 1, folders: [] };
  }
}

function covers(trusted: string, target: string, home: string): boolean {
  if (trusted === target) return true;
  if (trusted === home || trusted === parse(trusted).root) return false;
  return target.startsWith(trusted.endsWith(sep) ? trusted : trusted + sep);
}

export interface FolderTrustOptions {
  /** Store location (tests). Defaults to `~/.codepilot/trusted-folders.json`. */
  file?: string;
  /** Home directory used for the "too broad to inherit" rule. */
  home?: string;
}

/** The trusted folder that covers `dir`, or null when it is not trusted. */
export function findTrustedFolder(dir: string, opts: FolderTrustOptions = {}): TrustedFolder | null {
  const home = canonical(opts.home ?? homedir());
  const target = canonical(dir);
  const store = loadStore(opts.file ?? defaultFolderTrustPath(opts.home));
  for (const f of store.folders) {
    if (covers(canonical(f.path), target, home)) return f;
  }
  return null;
}

export function isFolderTrusted(dir: string, opts: FolderTrustOptions = {}): boolean {
  return findTrustedFolder(dir, opts) !== null;
}

/** Record `dir` as trusted. Idempotent; written atomically. */
export async function trustFolder(dir: string, opts: FolderTrustOptions = {}): Promise<void> {
  const file = opts.file ?? defaultFolderTrustPath(opts.home);
  const target = canonical(dir);
  const store = loadStore(file);
  if (store.folders.some((f) => canonical(f.path) === target)) return;
  store.folders.push({ path: target, trustedAt: new Date().toISOString() });
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, file);
}

/** True when `dir` is the home directory or the filesystem root — trust there
 * is exact-match only, so clients should word the prompt more strongly. */
export function isBroadFolder(dir: string, home: string = homedir()): boolean {
  const target = canonical(dir);
  return target === canonical(home) || target === parse(target).root;
}
