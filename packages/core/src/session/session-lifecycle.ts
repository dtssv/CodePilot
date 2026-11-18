// Session init/dispose and lifecycle-only helpers. Extracted from Session (move-only split).

import { INTERRUPTED_RESULT, NOT_STARTED_RESULT } from "../agent/agent-messages.js";
import { discoverCustomAgents, type CustomAgent } from "../skills/customAgents.js";
import { discoverSkills, type Skill } from "../skills/skills.js";
import { AuditLogger } from "../telemetry/audit.js";
import type { RedactionPattern } from "../permissions/redact.js";
import type { McpManager } from "../mcp/mcp.js";
import type { McpServerRequestHandler } from "../mcp/mcp-types.js";
import { onJobCompletion, readJobLog } from "../tools/bashJobs.js";
import { StaticSkillStore, type SkillToolHandle } from "../tools/skill.js";
import { BackgroundSubagentRegistry } from "../tools/index.js";
import type { ArtifactStore } from "../tools/artifacts.js";
import type {
  CodepilotConfig,
  Event,
  FollowUpItem,
  InterruptedRunInfo,
  SessionOptions,
} from "../types.js";
import type { ResolvedSandbox } from "../sandbox/sandbox.js";
import type { PersistentShell } from "../sandbox/persistentShell.js";
import type { LspManager } from "../workspace/lsp.js";
import { ensureProjectState, projectStatePath } from "../workspace/projectState.js";
import { getTracer } from "../telemetry/telemetry.js";
import { readGitBranch } from "../telemetry/eventMeta.js";
import { HookEngine } from "../hooks/hooks.js";
import {
  makeCheckpointHook,
  readCheckpoint,
  type CheckpointHook,
} from "./checkpoints.js";
import { registerSessionBuiltins, type BuiltinHost } from "./session-builtins.js";
import {
  sessionLoadFromDisk as sessionLoadFromDiskImpl,
  sessionPersistEvent as sessionPersistEventImpl,
  type PersistHost,
} from "./session-persist.js";
import { startMcp as startMcpImpl, formatInboundNotification } from "../mcp/sessionBind.js";
import { acquireSessionLock, type SessionLease } from "./sessionLock.js";
import { persistSessionCwd } from "./session-utils.js";
import type { BoundedSinkQueue } from "./sessionSink.js";

export type LifecycleHost = PersistHost & {
  disposed: boolean;
  readOnly: boolean;
  lockIdentity?: SessionOptions["lockIdentity"];
  writerLease: SessionLease | null;
  redactPatterns: readonly RedactionPattern[];
  hooks: HookEngine;
  mcp: McpManager | null;
  mcpReady: Promise<McpManager | null>;
  mcpUnregisterRequestHandler: (() => void) | null;
  mcpUnregisterToolsChanged: (() => void) | null;
  mcpUnregisterNotification: (() => void) | null;
  mcpRequestHandler: McpServerRequestHandler | null;
  pluginAgentDirs: string[];
  pluginSkillDirs: string[];
  skillToolHandle: SkillToolHandle | null;
  checkpointHook: CheckpointHook | null;
  jobListeners: Array<() => void>;
  listeners: Set<(e: Event) => void>;
  interruptedRecovery?: InterruptedRunInfo;
  followUpQueue: FollowUpItem[];
  backgroundSubagents: BackgroundSubagentRegistry;
  pendingCheckpoint: Promise<void> | null;
  eventSink: BoundedSinkQueue | undefined;
  lspManager: LspManager | null;
  netProxy: import("../workspace/netProxy.js").RunningNetProxy | null;
  persistentShell: PersistentShell | null;
  artifacts: ArtifactStore;
  sandbox: ResolvedSandbox;
  config: CodepilotConfig;
  onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
  onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
  loadFromDisk(): Promise<void>;
  rebuildSystemPrompt(opts?: { scope?: "full" | "volatile" }): Promise<void>;
  steerSystem(text: string): void;
  notify(e: Event): void;
  cancel(): void;
  cancelCacheWarm(): void;
};

function sessionRegisterBuiltins(host: LifecycleHost): void {
  registerSessionBuiltins(host as unknown as BuiltinHost);
}

async function sessionStartMcp(host: LifecycleHost): Promise<McpManager | null> {
  return startMcpImpl({
    config: host.config,
    cwd: host.cwd,
    mcpTrustFile: projectStatePath(host.cwd, "mcp-trust.json"),
    onMcpOpenAuthUrl: host.onMcpOpenAuthUrl,
    onMcpServerRequest: host.onMcpServerRequest,
    withToolRegistry: (fn) => fn(host.toolRegistry),
    setMcpRequestHandlerCleanup: (unregister) => {
      host.mcpUnregisterRequestHandler = unregister;
    },
    setMcpRequestHandler: (handler) => {
      host.mcpRequestHandler = handler;
    },
    setMcpToolsChangedCleanup: (unregister) => {
      host.mcpUnregisterToolsChanged = unregister;
    },
    onMcpInboundNotification: (server, method, params) => {
      host.steerSystem(formatInboundNotification(server, method, params));
    },
    setMcpNotificationCleanup: (unregister) => {
      host.mcpUnregisterNotification = unregister;
    },
  });
}

async function sessionSealOrphanedToolCalls(host: LifecycleHost): Promise<number> {
  const callNames = new Map<string, string>();
  const answered = new Set<string>();
  const started = new Set<string>();
  for (const e of host.events) {
    if (e.type === "tool_call") {
      if (!callNames.has(e.id)) callNames.set(e.id, e.name);
    } else if (e.type === "message" && e.role === "assistant") {
      for (const b of e.content) {
        if (b.type === "tool_use" && !callNames.has(b.id)) callNames.set(b.id, b.name);
      }
    } else if (e.type === "tool_result") {
      answered.add(e.toolCallId);
    } else if (e.type === "tool_started") {
      started.add(e.toolCallId);
    }
  }
  let sealed = 0;
  for (const [id, name] of callNames) {
    if (answered.has(id)) continue;
    const ev: Event = {
      type: "tool_result",
      toolCallId: id,
      name,
      content: started.has(id) ? INTERRUPTED_RESULT : NOT_STARTED_RESULT,
      isError: true,
    };
    host.events.push(ev);
    await sessionPersistEventImpl(host, ev).catch(() => undefined);
    sealed += 1;
  }
  return sealed;
}

async function sessionReconcileStaleStatus(host: LifecycleHost): Promise<void> {
  if (host.readOnly) return;
  let lastStatus: string | null = null;
  let lastClaim: Extract<Event, { type: "status" }>["claim"] | undefined;
  for (const e of host.events) {
    if (e.type === "status") {
      lastStatus = e.status;
      if (e.claim) lastClaim = e.claim;
    }
  }
  if (lastStatus === "running" || lastStatus === "waiting_permission") {
    const sealedToolCalls = await sessionSealOrphanedToolCalls(host);
    const ev: Event = { type: "status", status: "idle" };
    host.events.push(ev);
    await sessionPersistEventImpl(host, ev).catch(() => undefined);
    host.resumedFromInterrupt = true;
    host.interruptedRecovery = {
      sessionId: host.id,
      ...(lastClaim
        ? {
            claim: {
              executionId: lastClaim.executionId,
              turn: lastClaim.turn,
              model: lastClaim.model,
              startedAt: lastClaim.startedAt,
            },
          }
        : {}),
      sealedToolCalls,
    };
    host.notify({ type: "interrupted_run", ...host.interruptedRecovery });
  }
}

async function sessionStartNetProxyIfConfigured(host: LifecycleHost): Promise<void> {
  const pol = host.sandbox.networkPolicy;
  if (pol.mode !== "proxy") return;
  try {
    const { startNetProxy } = await import("../workspace/netProxy.js");
    host.netProxy = await startNetProxy({
      allow: pol.allow,
      allowPorts: pol.allowPorts,
      denyLog: pol.denyLog,
    });
    const { detectSandboxBackend, slirp4netnsPath } = await import("../sandbox/sandbox.js");
    const backend = detectSandboxBackend();
    const enforced =
      backend === "seatbelt" || (backend === "bwrap" && slirp4netnsPath() !== null);
    host.sandbox = {
      ...host.sandbox,
      proxyUrl: `http://127.0.0.1:${host.netProxy.port}`,
      proxyEnforcement: enforced ? "enforced" : "best-effort",
    };
  } catch (err) {
    process.stderr.write(
      `[session] network proxy failed to start: ${(err as Error).message}\n`,
    );
  }
}

export async function sessionInitAfterLease(host: LifecycleHost): Promise<void> {
  await ensureProjectState(host.cwd, { sessionId: host.id });
  await host.artifacts.init();
  await sessionStartNetProxyIfConfigured(host);
  sessionRegisterBuiltins(host);
  await host.loadFromDisk();
  await sessionReconcileStaleStatus(host);
  await persistSessionCwd(host.id, host.cwd).catch(() => undefined);
  host.gitBranchCache = readGitBranch(host.cwd);
  host.mcpReady = sessionStartMcp(host)
    .then(async (mcp) => {
      if (host.disposed) {
        host.mcpUnregisterRequestHandler?.();
        host.mcpUnregisterRequestHandler = null;
        host.mcpRequestHandler = null;
        host.mcpUnregisterToolsChanged?.();
        host.mcpUnregisterToolsChanged = null;
        host.mcpUnregisterNotification?.();
        host.mcpUnregisterNotification = null;
        const { releaseSharedMcp } = await import("../mcp/mcp-pool.js");
        await releaseSharedMcp(mcp);
        return null;
      }
      host.mcp = mcp;
      await host.rebuildSystemPrompt().catch(() => undefined);
      return mcp;
    })
    .catch((err) => {
      process.stderr.write(
        `[session] MCP background start failed: ${(err as Error).message}\n`,
      );
      return null;
    });
  await host.hooks.loadTrustedHashes();
  host.customAgents = await discoverCustomAgents(host.cwd, {
    extraDirs: host.pluginAgentDirs,
  }).catch(() => new Map<string, CustomAgent>());
  const skillsCfg = host.config.skills;
  if (skillsCfg?.enabled === false) {
    host.discoveredSkills = [];
  } else {
    const configuredDirs = (skillsCfg?.dirs ?? []).filter(
      (d): d is string => typeof d === "string" && d.trim().length > 0,
    );
    host.discoveredSkills = await discoverSkills(host.cwd, {
      extraDirs: [...host.pluginSkillDirs, ...configuredDirs],
      ...(skillsCfg?.disabled ? { disabledNames: skillsCfg.disabled } : {}),
    }).catch(() => []);
  }
  host.skillToolHandle?.setStore(new StaticSkillStore(host.discoveredSkills));
  await host.rebuildSystemPrompt();
  host.checkpointHook = makeCheckpointHook(host.cwd, host.id);
  if (host.events.length > 0) {
    host.checkpointHook.lastCheckpointAt = host.events.length;
  }
  const existing = await readCheckpoint(host.cwd, host.id);
  if (existing) {
    const headerMatch = existing.match(/^#\s+(.+)$/m);
    if (headerMatch) {
      const candidate = headerMatch[1]!.replace(/^Checkpoint for\s+/, "").trim();
      if (candidate) host.title = candidate;
    }
  }
  const source = host.events.length > 0 ? "resume" : "startup";
  await host.hooks.runSessionStart(source).catch(() => undefined);
  host.jobListeners.push(
    onJobCompletion(host.cwd, (meta) => {
      const status =
        meta.status === "exited"
          ? `exited with code ${meta.exitCode ?? "?"}`
          : meta.status === "killed"
            ? "was killed"
            : meta.status === "failed"
              ? "failed"
              : meta.status;
      const shown = (meta.displayCommand ?? meta.command).replace(/\s+/g, " ").trim().slice(0, 80);
      const failed =
        meta.status === "failed" ||
        (meta.status === "exited" && meta.exitCode !== 0 && meta.exitCode != null);
      const emit = (tail?: string): void => {
        let msg = `Background job ${meta.id} (${shown}) ${status}.`;
        if (failed && tail && tail.trim()) {
          msg += `\nLast output:\n${tail.trim().slice(-800)}`;
        } else {
          msg += ` Use bash_output({ job_id: "${meta.id}" }) to read its output.`;
        }
        host.steerSystem(msg);
      };
      if (failed) {
        readJobLog(host.cwd, meta.id, 20).then(emit).catch(() => emit());
      } else {
        emit();
      }
    }),
  );
  if (host.config.audit) {
    const dir = typeof host.config.audit === "object" ? host.config.audit.dir : undefined;
    const logger = new AuditLogger(host.id, { ...(dir ? { dir } : {}), redactPatterns: host.redactPatterns });
    host.listeners.add(logger.onEvent);
  }
}

export async function sessionInit(host: LifecycleHost): Promise<void> {
  if (!host.readOnly) {
    host.writerLease = acquireSessionLock(host.id, {
      ...(host.lockIdentity?.host ? { host: host.lockIdentity.host } : {}),
      ...(host.lockIdentity?.url ? { url: host.lockIdentity.url } : {}),
      ...(host.lockIdentity?.token ? { token: host.lockIdentity.token } : {}),
    });
  }
  try {
    await sessionInitAfterLease(host);
  } catch (err) {
    try {
      host.writerLease?.release();
    } catch {
      /* reclaim handles a leftover lock */
    }
    host.writerLease = null;
    throw err;
  }
}

export async function sessionDispose(host: LifecycleHost): Promise<void> {
  host.disposed = true;
  host.followUpQueue = [];
  host.backgroundSubagents.interruptAll();
  await getTracer().flush().catch(() => undefined);
  if (host.pendingCheckpoint) {
    await host.pendingCheckpoint.catch(() => undefined);
  }
  if (host.eventSink) {
    const sink = host.eventSink;
    host.eventSink = undefined;
    await sink.close().catch(() => undefined);
  }
  host.cancelCacheWarm();
  host.cancel();
  host.listeners.clear();
  for (const off of host.jobListeners) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
  host.jobListeners = [];
  if (host.lspManager) {
    const mgr = host.lspManager;
    host.lspManager = null;
    void mgr.stopAll().catch(() => undefined);
  }
  if (host.netProxy) {
    const proxy = host.netProxy;
    host.netProxy = null;
    void proxy.close().catch(() => undefined);
  }
  if (host.persistentShell) {
    host.persistentShell.close();
    host.persistentShell = null;
  }
  const mcp = host.mcp;
  host.mcp = null;
  host.mcpReady = Promise.resolve(null);
  host.mcpUnregisterRequestHandler?.();
  host.mcpUnregisterRequestHandler = null;
  host.mcpRequestHandler = null;
  host.mcpUnregisterToolsChanged?.();
  host.mcpUnregisterToolsChanged = null;
  host.mcpUnregisterNotification?.();
  host.mcpUnregisterNotification = null;
  if (mcp) {
    const { releaseSharedMcp } = await import("../mcp/mcp-pool.js");
    await releaseSharedMcp(mcp);
  }
  try {
    host.writerLease?.release();
  } catch {
    /* best-effort — a crashed-owner reclaim handles a leftover lock */
  }
  host.writerLease = null;
}