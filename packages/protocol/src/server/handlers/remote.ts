import QRCode from "qrcode";
import {
  mintRemotePairing,
  redeemRemotePairing,
  revokeAllRemoteControl,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import { assertInitialized, type ServerContext } from "../context.js";

export async function handleRemotePairMint(
  ctx: ServerContext,
  params: { serveUrl: string; cwd?: string; cwds?: string[]; sessionId?: string },
): Promise<{
  code: string;
  url: string;
  qrPayload: string;
  expiresAt: number;
  qrDataUrl: string;
  rewritten?: boolean;
  warning?: string;
  lanIp?: string;
}> {
  assertInitialized(ctx);
  if (!params?.serveUrl || typeof params.serveUrl !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, "serveUrl required");
  }
  const minted = await mintRemotePairing({
    serveUrl: params.serveUrl,
    cwd: params.cwd || ctx.defaultCwd,
    cwds: Array.isArray(params.cwds) ? params.cwds.filter((c) => typeof c === "string" && c.trim()) : undefined,
    sessionId: params.sessionId,
  });
  const qrDataUrl = await QRCode.toDataURL(minted.qrPayload, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return {
    code: minted.code,
    url: minted.url,
    qrPayload: minted.qrPayload,
    expiresAt: minted.expiresAt,
    qrDataUrl,
    rewritten: minted.rewritten,
    warning: minted.warning,
    lanIp: minted.lanIp,
  };
}

export async function handleRemotePairRedeem(
  params: { code: string; secret: string },
): Promise<{ token: string; cwd: string; sessionId?: string; caps: string[] }> {
  if (!params?.code || !params?.secret) {
    throw new RpcError(ErrorCode.InvalidParams, "code and secret required");
  }
  const r = await redeemRemotePairing(params.code, params.secret);
  return {
    token: r.grant.token,
    cwd: r.cwd,
    sessionId: r.sessionId,
    caps: [...r.grant.caps],
  };
}

export async function handleRemoteRevokeAll(): Promise<{ revoked: boolean }> {
  await revokeAllRemoteControl();
  return { revoked: true };
}