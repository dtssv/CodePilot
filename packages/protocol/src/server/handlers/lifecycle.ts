import { currentInstalledVersion, PROVIDER_NAMES } from "@codepilot/core";
import { ErrorCode, PROTOCOL_VERSION, RpcError } from "../../rpc.js";
import { assertCwdInGrantScope, type ServerContext } from "../context.js";
import { stopWatcher } from "./workspace.js";
import { releaseSession } from "../liveSessions.js";
import type { InitializeParams, InitializeResult } from "../wireTypes.js";
import { SUPPORTED_MODES } from "../../server.js";

export function defaultCapabilities(): InitializeResult["capabilities"] {
  return {
    tools: [
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "ls",
      "plan",
      "memory_write",
      "task",
      "read_artifact",
      "web_fetch",
    ],
    providers: [...PROVIDER_NAMES],
    modes: [...SUPPORTED_MODES],
    config: true,
    setModel: true,
    workspacePick: true,
    remoteControl: false,
    git: true,
  };
}

export async function handleInitialize(
  ctx: ServerContext,
  params: InitializeParams,
): Promise<InitializeResult> {
  if (!params || typeof params !== "object") {
    throw new RpcError(ErrorCode.InvalidParams, "initialize params required");
  }
  if (params.protocolVersion !== PROTOCOL_VERSION) {
    throw new RpcError(
      ErrorCode.ProtocolVersionMismatch,
      `Unsupported protocol version: ${params.protocolVersion}`,
      { supported: [PROTOCOL_VERSION] },
    );
  }
  if (params.cwd && typeof params.cwd === "string") {
    // A scoped remote grant may only set its default cwd to an authorized
    // workspace — otherwise every cwd-defaulting RPC would silently operate
    // outside the grant.
    assertCwdInGrantScope(ctx, params.cwd);
    ctx.defaultCwd = params.cwd;
  }
  if (params.permissionMode) {
    ctx.defaultPermissionMode = params.permissionMode;
  }
  ctx.initialized = true;
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ctx.capabilities,
    serverInfo: {
      name: "codepilot",
      version: currentInstalledVersion(),
      channel: "engine",
    },
  };
}

/** Release every session this connection owns. Soft by default (busy runs
 * survive); pass `{ force: true }` from shutdown to cancel everything. */
export async function teardown(
  ctx: ServerContext,
  opts: { force?: boolean } = {},
): Promise<void> {
  stopWatcher(ctx);
  ctx.terminals.disposeAll();
  for (const id of Array.from(ctx.sessions.keys())) {
    await releaseSession(ctx, id, opts);
  }
  ctx.sessionSubs.clear();
}

export async function handleShutdown(
  ctx: ServerContext,
): Promise<Record<string, never>> {
  // Client asked to shut down this connection for real — cancel busy runs too.
  await teardown(ctx, { force: true });
  // Tear the peer down after the response is sent.
  setImmediate(() => {
    void ctx.peer.close();
  });
  return {};
}