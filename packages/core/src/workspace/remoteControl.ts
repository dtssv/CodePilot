/**
 * One-time QR / link remote control pairing.
 *
 * Security model (stricter than a long-lived serve token):
 * - Pairing codes are single-use: redeemed once → consumed.
 * - Short TTL (default 2 minutes); unused codes expire.
 * - Bound to the local serve origin + an optional session id.
 * - Remote clients get a **scoped** control token (not the master serve token)
 *   with reduced privileges: prompt/cancel/follow only; no config mutation,
 *   no update-apply, no arbitrary workspace browse outside the bound cwd.
 * - Rate-limit minting to reduce QR spray / brute force.
 *
 * Persistence: `~/.codepilot/remote-control.json` (pairing + active grants).
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { advertiseUrl } from "./netAdvertise.js";

const STORE = join(homedir(), ".codepilot", "remote-control.json");
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_PAIRINGS = 3;
const MINT_COOLDOWN_MS = 5_000;

export interface RemotePairing {
  /** Public code shown in QR (not a secret by itself — one-time). */
  code: string;
  /** Hash of the redeem secret embedded in the deep link. */
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  /** Primary (active) workspace the phone opens into. */
  cwd: string;
  /** All workspaces authorized for this pairing (includes `cwd`). The phone
   * lists exactly these; defaults to `[cwd]` for older single-workspace links. */
  cwds?: string[];
  sessionId?: string;
  /** Serve URL the phone should connect to (ws/http). */
  serveUrl: string;
  consumed: boolean;
}

export interface RemoteGrant {
  /** Opaque bearer for remote control (scoped). */
  token: string;
  createdAt: number;
  expiresAt: number;
  /** Primary (active) workspace. */
  cwd: string;
  /** All workspaces this grant may use (includes `cwd`). */
  cwds?: string[];
  sessionId?: string;
  /** Capabilities allowed for this grant. */
  caps: ("prompt" | "cancel" | "follow" | "answer")[];
}

interface StoreFile {
  pairings: RemotePairing[];
  grants: RemoteGrant[];
  lastMintAt: number;
}

function emptyStore(): StoreFile {
  return { pairings: [], grants: [], lastMintAt: 0 };
}

async function loadStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(STORE, "utf-8");
    const j = JSON.parse(raw) as StoreFile;
    return {
      pairings: Array.isArray(j.pairings) ? j.pairings : [],
      grants: Array.isArray(j.grants) ? j.grants : [],
      lastMintAt: typeof j.lastMintAt === "number" ? j.lastMintAt : 0,
    };
  } catch {
    return emptyStore();
  }
}

async function saveStore(s: StoreFile): Promise<void> {
  await mkdir(join(homedir(), ".codepilot"), { recursive: true });
  await writeFile(STORE, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function prune(s: StoreFile, now = Date.now()): StoreFile {
  return {
    ...s,
    pairings: s.pairings.filter((p) => !p.consumed && p.expiresAt > now),
    grants: s.grants.filter((g) => g.expiresAt > now),
  };
}

export interface MintRemotePairingOpts {
  serveUrl: string;
  cwd: string;
  /** Additional workspaces to authorize alongside `cwd`. The phone lists the
   * union of `cwd` + these; omitted means the single bound workspace. */
  cwds?: string[];
  sessionId?: string;
  ttlMs?: number;
  /** Grant lifetime after redeem (default 8h). */
  grantTtlMs?: number;
}

export interface MintRemotePairingResult {
  /** Short human code (also in QR payload). */
  code: string;
  /** Full one-time URL for QR (contains secret; display once). */
  url: string;
  expiresAt: number;
  /** QR payload string (same as url for scanners). */
  qrPayload: string;
  /** True when loopback host was rewritten to a LAN IP. */
  rewritten?: boolean;
  /** Advisory for the UI (e.g. need --host 0.0.0.0). */
  warning?: string;
  /** LAN IP used in the QR URL, if rewritten. */
  lanIp?: string;
}

/**
 * Mint a one-time pairing. Throws if minting too frequently.
 */
export async function mintRemotePairing(
  opts: MintRemotePairingOpts,
): Promise<MintRemotePairingResult> {
  const now = Date.now();
  let store = prune(await loadStore(), now);
  if (now - store.lastMintAt < MINT_COOLDOWN_MS) {
    throw new Error("Remote pairing rate-limited — wait a few seconds before minting another QR.");
  }
  if (store.pairings.length >= MAX_ACTIVE_PAIRINGS) {
    throw new Error("Too many unused pairing codes — wait for expiry or redeem/cancel existing ones.");
  }

  const advertised = advertiseUrl(opts.serveUrl);
  const serveUrl = advertised.url;

  const code = randomBytes(3).toString("hex"); // 6 hex chars
  const secret = randomBytes(24).toString("base64url");
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  // Authorized set: the active cwd first, then any extras, deduped.
  const cwds = [opts.cwd, ...(opts.cwds ?? [])].filter(
    (c, i, arr) => c && arr.indexOf(c) === i,
  );
  const pairing: RemotePairing = {
    code,
    secretHash: hashSecret(secret),
    createdAt: now,
    expiresAt: now + ttl,
    cwd: opts.cwd,
    cwds,
    sessionId: opts.sessionId,
    serveUrl,
    consumed: false,
  };
  store.pairings.push(pairing);
  store.lastMintAt = now;
  await saveStore(store);

  const base = serveUrl.replace(/\/+$/, "");
  const url = `${base}/remote/pair?code=${encodeURIComponent(code)}&s=${encodeURIComponent(secret)}`;
  return {
    code,
    url,
    expiresAt: pairing.expiresAt,
    qrPayload: url,
    rewritten: advertised.rewritten,
    warning: advertised.warning,
    lanIp: advertised.lanIp,
  };
}

export interface RedeemRemotePairingResult {
  grant: RemoteGrant;
  cwd: string;
  cwds: string[];
  sessionId?: string;
  serveUrl: string;
}

/**
 * Redeem a one-time code+secret. Fails if already used, expired, or mismatch.
 */
export async function redeemRemotePairing(
  code: string,
  secret: string,
  opts?: { grantTtlMs?: number },
): Promise<RedeemRemotePairingResult> {
  const now = Date.now();
  let store = prune(await loadStore(), now);
  const idx = store.pairings.findIndex((p) => p.code === code && !p.consumed);
  if (idx < 0) {
    throw new Error("Invalid or already-used pairing code.");
  }
  const pairing = store.pairings[idx]!;
  if (pairing.expiresAt <= now) {
    store.pairings.splice(idx, 1);
    await saveStore(store);
    throw new Error("Pairing code expired.");
  }
  if (pairing.secretHash !== hashSecret(secret)) {
    throw new Error("Pairing secret mismatch.");
  }

  pairing.consumed = true;
  store.pairings.splice(idx, 1);

  const grantTtl = opts?.grantTtlMs ?? 8 * 60 * 60 * 1000;
  const cwds = pairing.cwds?.length ? pairing.cwds : [pairing.cwd];
  const grant: RemoteGrant = {
    token: randomBytes(32).toString("base64url"),
    createdAt: now,
    expiresAt: now + grantTtl,
    cwd: pairing.cwd,
    cwds,
    sessionId: pairing.sessionId,
    caps: ["prompt", "cancel", "follow", "answer"],
  };
  store.grants.push(grant);
  await saveStore(store);

  return {
    grant,
    cwd: pairing.cwd,
    cwds,
    sessionId: pairing.sessionId,
    serveUrl: pairing.serveUrl,
  };
}

/** Validate a scoped remote-control bearer. */
export async function resolveRemoteGrant(token: string): Promise<RemoteGrant | null> {
  const now = Date.now();
  const store = prune(await loadStore(), now);
  const g = store.grants.find((x) => x.token === token);
  return g && g.expiresAt > now ? g : null;
}

export function remoteGrantAllows(grant: RemoteGrant, cap: RemoteGrant["caps"][number]): boolean {
  return grant.caps.includes(cap);
}

/** Revoke all grants and unused pairings (panic button). */
export async function revokeAllRemoteControl(): Promise<void> {
  await saveStore(emptyStore());
}

export async function cancelUnusedPairings(): Promise<number> {
  const store = await loadStore();
  const n = store.pairings.length;
  store.pairings = [];
  await saveStore(store);
  return n;
}
