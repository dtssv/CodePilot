/**
 * Settings sub-sections: 连接器 · 自定义连接器 · 技能 · 远程 · 定时 · 通用
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentMode, PermissionMode } from "@codepilot/core";

import type { Codepilot } from "../state/useCodepilot.js";
import { describeError } from "../protocol/client.js";
import { getLocale, setLocale, t, type Locale } from "../i18n.js";
import {
  loadPermissionMode,
  saveDefaultAgentMode,
  savePermissionMode,
} from "../prefs.js";
import type { Layout, Theme } from "../surface.js";
import { CustomMcpPanel } from "./CustomMcpModal.js";

const PAGE_SIZE = 24;
type ListTab = "all" | "installed";

/**
 * The HTTP(S) origin a phone should connect to for remote pairing.
 *
 * On the web-served surface this is just `window.location` origin. On the
 * desktop app the SPA is loaded over `file://` (so `window.location` is
 * `file://` with an empty host), but the daemon's real URL is passed in the
 * `?ws=` query param — convert that ws(s):// URL to http(s)://. Without this
 * the QR payload becomes `file://.../remote/pair?...`, which no phone can open.
 */
function resolveServeUrl(): string {
  const origin = `${window.location.protocol}//${window.location.host}`;
  if (window.location.protocol !== "file:" && window.location.host) {
    return origin;
  }
  const ws = new URLSearchParams(window.location.search).get("ws");
  if (ws) {
    try {
      const u = new URL(ws);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      // Drop the ws path (e.g. "/rpc") — the pairing/static routes live at the
      // origin root. Keeping it made the phone load the SPA under /rpc/remote/,
      // so its relative ./assets/ 404'd and the pair route never matched.
      u.pathname = "/";
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/+$/, "");
    } catch {
      /* fall through */
    }
  }
  return origin;
}


export type SettingsExtraSection =
  | "connectors"
  | "custom-mcp"
  | "skills"
  | "remote"
  | "schedule"
  | "general";

type ConnectorStatus = {
  id: string;
  installed: boolean;
  enabled: boolean;
  mcpName?: string;
  skillName?: string;
  skillInstalled?: boolean;
};

type Connector = {
  id: string;
  name: string;
  description: string;
  category: string;
  credentials: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
  }>;
  securityNotice: string;
  docsUrl?: string;
  authUrl?: string;
  status: ConnectorStatus;
};

type ManagedSkill = {
  name: string;
  description: string;
  state: "installed" | "available";
  enabled: boolean;
  source?: string;
  connectorId?: string;
  when?: string;
};

type Task = {
  id: string;
  title: string;
  prompt?: string;
  kind: string;
  enabled: boolean;
  lastStatus?: string;
  lastRunAt?: number;
  lastError?: string;
  idleAfterMs?: number;
  at?: string;
  runAt?: number;
  everyMinutes?: number;
  runCount?: number;
  model?: string;
  providerId?: string;
  agentMode?: "chat" | "plan" | "agent";
};

type ScheduleModelOpt = {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
};

export function SettingsExtras({
  cp,
  section,
  onComposePrompt,
  theme,
  onTheme,
  layout,
  onLayout,
}: {
  cp: Codepilot;
  section: SettingsExtraSection;
  onComposePrompt?: (text: string) => void;
  theme: Theme;
  onTheme(theme: Theme): void;
  layout: Layout;
  onLayout(layout: Layout): void;
}): React.ReactElement {
  const { client, state } = cp;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorsTotal, setConnectorsTotal] = useState(0);
  const [connectorTab, setConnectorTab] = useState<ListTab>("all");
  const [connectorQuery, setConnectorQuery] = useState("");
  const [connectorQueryDraft, setConnectorQueryDraft] = useState("");
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [skillsTotal, setSkillsTotal] = useState(0);
  const [skillTab, setSkillTab] = useState<ListTab>("all");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillQueryDraft, setSkillQueryDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [skillMarkdown, setSkillMarkdown] = useState("");
  const [skillEditHint, setSkillEditHint] = useState<string | undefined>();
  const [skillFiles, setSkillFiles] = useState<string[]>(["SKILL.md"]);
  const [skillActiveFile, setSkillActiveFile] = useState("SKILL.md");
  const [newSkillFilePath, setNewSkillFilePath] = useState("");
  const [addingSkillFile, setAddingSkillFile] = useState(false);
  const [selected, setSelected] = useState<Connector | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editCredentials, setEditCredentials] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string | null; available: boolean; canAutoApply: boolean } | null>(null);
  const [imgGen, setImgGen] = useState<{ baseURL: string; apiKey: string; model: string; enabled: boolean; hasApiKey: boolean }>({
    baseURL: "",
    apiKey: "",
    model: "",
    enabled: true,
    hasApiKey: false,
  });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [qr, setQr] = useState<{
    url: string;
    code: string;
    expiresAt: number;
    qrDataUrl: string;
  } | null>(null);
  // Desktop-only: whether the shared engine binds the LAN so a phone can reach
  // it. `null` = unknown / not the desktop surface (hides the toggle).
  const [lanAccess, setLanAccess] = useState<boolean | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  // Workspaces to authorize for the next QR (the phone lists exactly these).
  // Defaults to the active workspace; the user can tick more before minting.
  const [pairCwds, setPairCwds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [idlePrompt, setIdlePrompt] = useState("");
  const [idleTitle, setIdleTitle] = useState("闲时任务");
  const [taskKind, setTaskKind] = useState<"idle" | "once" | "daily" | "interval">("idle");
  const [taskAt, setTaskAt] = useState("09:00");
  const [taskOnceAt, setTaskOnceAt] = useState(""); // datetime-local value for one-time tasks
  const [taskEvery, setTaskEvery] = useState(60);
  const [idleModelKey, setIdleModelKey] = useState(""); // "" = default; else providerId::model
  const [idleAgentMode, setIdleAgentMode] = useState<"chat" | "plan" | "agent">("agent");
  const [scheduleModels, setScheduleModels] = useState<ScheduleModelOpt[]>([]);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const skillFileRef = useRef<HTMLInputElement>(null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => loadPermissionMode());

  const loadConnectors = useCallback(
    async (opts?: { offset?: number }) => {
      if (state.connection !== "connected") return;
      try {
        const offset = opts?.offset ?? 0;
        const page = await client.listConnectors({
          q: connectorQuery || undefined,
          tab: connectorTab,
          offset,
          limit: PAGE_SIZE,
        });
        const items = page.connectors as Connector[];
        setConnectors((prev) => (offset > 0 ? [...prev, ...items] : items));
        setConnectorsTotal(page.total);
        setError(undefined);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [client, state.connection, connectorQuery, connectorTab],
  );

  const loadSkills = useCallback(
    async (opts?: { offset?: number }) => {
      if (state.connection !== "connected") return;
      try {
        const offset = opts?.offset ?? 0;
        const page = await client.listSkills({
          q: skillQuery || undefined,
          tab: skillTab,
          offset,
          limit: PAGE_SIZE,
        });
        setSkills((prev) => (offset > 0 ? [...prev, ...page.skills] : page.skills));
        setSkillsTotal(page.total);
        setError(undefined);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [client, state.connection, skillQuery, skillTab],
  );

  const reload = useCallback(async () => {
    if (state.connection !== "connected") return;
    try {
      if (section === "connectors") {
        await loadConnectors();
      } else if (section === "skills") {
        await loadSkills();
      } else if (section === "schedule") {
        const [s, cfg] = await Promise.all([
          client.listScheduledTasks(),
          client.getConfig().catch(() => null),
        ]);
        setTasks(s.tasks as Task[]);
        if (cfg) {
          setScheduleModels(
            cfg.selectableModels
              .filter((m) => m.kind === "chat")
              .map((m) => ({
                id: m.id,
                providerId: m.providerId,
                providerLabel: m.providerLabel,
                model: m.model,
              })),
          );
        }
      }
      setError(undefined);
    } catch (err) {
      setError(describeError(err));
    }
  }, [client, state.connection, section, loadConnectors, loadSkills]);

  useEffect(() => {
    if (section === "connectors") void loadConnectors();
    else if (section === "skills") void loadSkills();
    else if (section === "schedule") void reload();
    else if (section === "general" && state.connection === "connected") {
      void client
        .getConfig()
        .then((cfg) => {
          if (cfg.imageGen) {
            setImgGen((prev) => ({
              ...prev,
              baseURL: cfg.imageGen?.baseURL ?? "",
              model: cfg.imageGen?.model ?? "",
              enabled: cfg.imageGen?.enabled !== false,
              hasApiKey: !!cfg.imageGen?.hasApiKey,
              apiKey: "",
            }));
          }
        })
        .catch(() => {});
    }
  }, [section, connectorQuery, connectorTab, skillQuery, skillTab, state.connection]);

  // Notices are section-local; clear when switching tabs so QR tips don't leak.
  useEffect(() => {
    setNotice(undefined);
    setError(undefined);
    setSelected(null);
    setEditCredentials(false);
    setValues({});
  }, [section]);

  // Load the current LAN-access preference from the desktop host (if any).
  useEffect(() => {
    if (section !== "general") return;
    const getter = window.codepilotDesktop?.getLanAccess;
    if (!getter) {
      setLanAccess(null);
      return;
    }
    void getter()
      .then((v) => setLanAccess(v))
      .catch(() => setLanAccess(null));
  }, [section]);

  const toggleLanAccess = async (next: boolean): Promise<void> => {
    const setter = window.codepilotDesktop?.setLanAccess;
    if (!setter) return;
    setLanBusy(true);
    setError(undefined);
    try {
      const applied = await setter(next);
      setLanAccess(applied);
      setNotice(
        applied
          ? t("LAN access on — the engine restarted. Generate a fresh QR to pair your phone.")
          : t("LAN access off — the engine now accepts loopback connections only."),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLanBusy(false);
    }
  };

  const saveConnector = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const r = selected.status.installed
        ? await client.updateConnector(selected.id, values)
        : await client.installConnector(selected.id, values);
      setNotice(r.message);
      setSelected(null);
      setValues({});
      setEditCredentials(false);
      await loadConnectors();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleConnector = async (c: Connector, enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await client.setConnectorEnabled(c.id, enabled);
      setNotice(r.message);
      await loadConnectors();
      if (selected?.id === c.id) {
        setSelected((prev) =>
          prev
            ? {
                ...prev,
                status: { ...prev.status, enabled },
              }
            : null,
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSkill = async (sk: ManagedSkill, enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await client.setSkillEnabled(sk.name, enabled);
      setNotice(r.message);
      await loadSkills();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const installSkill = async (sk: ManagedSkill): Promise<void> => {
    if (!sk.connectorId) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await client.installSkill(sk.connectorId);
      setNotice(r.message);
      await loadSkills();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const startCreateViaSkillCreator = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const { prompt } = await client.skillCreatorPrompt();
      onComposePrompt?.(prompt);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const openEditSkill = async (sk: ManagedSkill): Promise<void> => {
    if (sk.state !== "installed") return;
    setBusy(true);
    setError(undefined);
    try {
      const c = await client.getSkillContent(sk.name);
      const files = c.files?.length ? c.files : ["SKILL.md"];
      setEditingSkill(sk.name);
      setSkillFiles(files);
      setSkillActiveFile("SKILL.md");
      setSkillMarkdown(c.markdown);
      setSkillEditHint(
        c.readOnlySource
          ? t("Builtin skill — saving creates a user copy you can edit.")
          : c.rootDir ?? c.path,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const switchSkillFile = async (relativePath: string): Promise<void> => {
    if (!editingSkill || relativePath === skillActiveFile) return;
    setBusy(true);
    setError(undefined);
    try {
      const f = await client.getSkillFile(editingSkill, relativePath);
      setSkillActiveFile(f.relativePath);
      setSkillMarkdown(f.content);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshSkillFiles = async (skillName: string): Promise<void> => {
    try {
      const c = await client.getSkillContent(skillName);
      setSkillFiles(c.files?.length ? c.files : ["SKILL.md"]);
      setSkillEditHint(c.rootDir ?? c.path);
    } catch {
      /* keep current list */
    }
  };

  const addSkillFile = async (): Promise<void> => {
    if (!editingSkill) return;
    const rel = newSkillFilePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel === "SKILL.md") {
      setError(t("Enter a relative path such as templates/example.md"));
      return;
    }
    if (rel.includes("..") || rel.split("/").some((p) => p === "" || p === ".")) {
      setError(t("Invalid file path"));
      return;
    }
    if (skillFiles.includes(rel)) {
      setAddingSkillFile(false);
      setNewSkillFilePath("");
      await switchSkillFile(rel);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // Persist current buffer first so switching does not lose edits.
      if (skillActiveFile === "SKILL.md") {
        await client.saveSkillContent(editingSkill, skillMarkdown);
      } else {
        await client.saveSkillFile(editingSkill, skillActiveFile, skillMarkdown);
      }
      const starter =
        rel.endsWith(".md")
          ? `# ${rel.split("/").pop()?.replace(/\.md$/i, "") ?? "template"}\n\n`
          : "";
      const r = await client.saveSkillFile(editingSkill, rel, starter);
      setNotice(r.message);
      setSkillFiles((prev) => (prev.includes(rel) ? prev : [...prev, rel].sort((a, b) => {
        if (a === "SKILL.md") return -1;
        if (b === "SKILL.md") return 1;
        return a.localeCompare(b);
      })));
      setSkillActiveFile(rel);
      setSkillMarkdown(starter);
      setNewSkillFilePath("");
      setAddingSkillFile(false);
      await refreshSkillFiles(editingSkill);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEditSkill = async (): Promise<void> => {
    if (!editingSkill) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const r =
        skillActiveFile === "SKILL.md"
          ? await client.saveSkillContent(editingSkill, skillMarkdown)
          : await client.saveSkillFile(editingSkill, skillActiveFile, skillMarkdown);
      setNotice(r.message);
      await refreshSkillFiles(editingSkill);
      await loadSkills();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSkillArchive = async (file: File): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const dataBase64 = btoa(binary);
      const r = await client.installSkillArchive(file.name, dataBase64);
      setNotice(r.message);
      await loadSkills();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // Entering the Remote tab: default the authorize list to the active cwd.
  useEffect(() => {
    if (section !== "remote") return;
    setPairCwds(state.cwd ? [state.cwd] : []);
  }, [section, state.cwd]);

  const togglePairCwd = (cwd: string): void => {
    setPairCwds((prev) =>
      prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd],
    );
  };

  const mintQr = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const serveUrl = resolveServeUrl();
      // Active workspace is always authorized; the ticked extras ride along.
      const active = state.cwd || undefined;
      const extras = pairCwds.filter((c) => c && c !== state.cwd);
      const r = await client.mintRemotePairing({
        serveUrl,
        cwd: active,
        cwds: extras.length ? [...(active ? [active] : []), ...extras] : undefined,
        sessionId: state.sessionId || undefined,
      });
      setQr({
        url: r.qrPayload,
        code: r.code,
        expiresAt: r.expiresAt,
        qrDataUrl: r.qrDataUrl,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const parseIdleModel = (): { model?: string; providerId?: string } => {
    if (!idleModelKey.trim()) return {};
    if (!idleModelKey.includes("::")) return { model: idleModelKey.trim() };
    const [providerId, ...rest] = idleModelKey.split("::");
    const model = rest.join("::").trim();
    if (!model) return {};
    return providerId ? { model, providerId } : { model };
  };

  const addIdle = async (): Promise<void> => {
    if (!idlePrompt.trim()) return;
    setBusy(true);
    try {
      const { model, providerId } = parseIdleModel();
      await client.addScheduledTask({
        title: idleTitle.trim() || t("Scheduled task"),
        prompt: idlePrompt.trim(),
        cwd: state.cwd || undefined,
        kind: taskKind,
        ...(taskKind === "idle" ? { idleAfterMs: 10 * 60 * 1000 } : {}),
        ...(taskKind === "once" ? { runAt: taskOnceAt ? new Date(taskOnceAt).getTime() : Date.now() } : {}),
        ...(taskKind === "daily" ? { at: taskAt } : {}),
        ...(taskKind === "interval" ? { everyMinutes: Math.max(1, taskEvery) } : {}),
        model,
        providerId,
        agentMode: idleAgentMode,
      });
      setIdlePrompt("");
      setEditingTaskId(null);
      await reload();
      setNotice(
        taskKind === "idle"
          ? t("Idle task queued — runs when the engine is free.")
          : t("Scheduled task saved."),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const beginEditIdle = (task: Task): void => {
    if (task.lastRunAt) return;
    setEditingTaskId(task.id);
    setIdleTitle(task.title);
    setIdlePrompt(task.prompt ?? "");
    setIdleAgentMode(task.agentMode ?? "agent");
    if (task.kind === "idle" || task.kind === "once" || task.kind === "daily" || task.kind === "interval") {
      setTaskKind(task.kind);
    }
    if (task.at) setTaskAt(task.at);
    if (task.runAt) {
      // Convert epoch ms → local datetime-local string (YYYY-MM-DDTHH:mm).
      const d = new Date(task.runAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      setTaskOnceAt(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      );
    }
    if (task.everyMinutes) setTaskEvery(task.everyMinutes);
    setIdleModelKey(
      task.model && task.providerId
        ? `${task.providerId}::${task.model}`
        : task.model
          ? task.model
          : "",
    );
  };

  const cancelEditIdle = (): void => {
    setEditingTaskId(null);
    setIdleTitle("闲时任务");
    setIdlePrompt("");
    setIdleModelKey("");
    setIdleAgentMode("agent");
    setTaskKind("idle");
    setTaskOnceAt("");
  };

  const saveEditIdle = async (): Promise<void> => {
    if (!editingTaskId || !idlePrompt.trim()) return;
    setBusy(true);
    try {
      const { model, providerId } = parseIdleModel();
      await client.updateScheduledTask(editingTaskId, {
        title: idleTitle.trim() || "闲时任务",
        prompt: idlePrompt.trim(),
        ...(taskKind === "idle" ? { idleAfterMs: 10 * 60 * 1000 } : {}),
        ...(taskKind === "once" ? { runAt: taskOnceAt ? new Date(taskOnceAt).getTime() : Date.now() } : {}),
        ...(taskKind === "daily" ? { at: taskAt } : {}),
        ...(taskKind === "interval" ? { everyMinutes: Math.max(1, taskEvery) } : {}),
        model,
        providerId,
        agentMode: idleAgentMode,
      });
      cancelEditIdle();
      await reload();
      setNotice(t("Idle task updated."));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeAllRemote = async (): Promise<void> => {
    if (!window.confirm(t("Revoke all remote access? Paired devices will need to scan a new code."))) return;
    setBusy(true);
    try {
      await client.revokeAllRemote();
      setNotice(t("All remote grants revoked."));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (id: string): Promise<void> => {
    if (!window.confirm(t("Remove this scheduled task?"))) return;
    setBusy(true);
    try {
      await client.removeScheduledTask(id);
      if (editingTaskId === id) cancelEditIdle();
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const checkUpdate = async (): Promise<void> => {
    setUpdateBusy(true);
    setError(undefined);
    try {
      const { engine } = await client.checkEngineUpdate();
      setUpdateInfo({
        current: engine.current,
        latest: engine.latest,
        available: engine.available,
        canAutoApply: engine.canAutoApply,
      });
      if (!engine.available) setNotice(`${t("You’re up to date")} (${engine.current})`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUpdateBusy(false);
    }
  };

  const applyUpdate = async (): Promise<void> => {
    setUpdateBusy(true);
    setError(undefined);
    try {
      const r = await client.applyEngineUpdate();
      setNotice(
        r.applied
          ? `${t("Updated to")} ${r.version}. ${t("Restart to use the new engine.")}`
          : r.message || t("Update could not be applied"),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUpdateBusy(false);
    }
  };

  const saveImageGen = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.setImageGen({
        baseURL: imgGen.baseURL.trim(),
        // Empty string = keep existing key (server preserves it).
        apiKey: imgGen.apiKey,
        model: imgGen.model.trim(),
        enabled: imgGen.enabled,
      });
      setImgGen((prev) => ({
        ...prev,
        apiKey: "",
        hasApiKey: r.imageGen.hasApiKey,
        baseURL: r.imageGen.baseURL ?? prev.baseURL,
        model: r.imageGen.model ?? prev.model,
        enabled: r.imageGen.enabled,
      }));
      setNotice(t("Image generation settings saved — applies on next session."));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const statusBadge = (c: Connector): React.ReactNode => {
    if (!c.status.installed) {
      return (
        <span className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]">
          {t("Not installed")}
        </span>
      );
    }
    if (!c.status.enabled) {
      return (
        <span className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-warn)]">
          {t("Disabled")}
        </span>
      );
    }
    return (
      <span className="rounded bg-[var(--color-add)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-add)]">
        {t("Installed")}
      </span>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {error && (
        <div className="mb-3 rounded-lg border border-[var(--color-remove)]/30 bg-[var(--color-remove)]/10 px-3 py-2 text-[12px] text-[var(--color-remove)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)] px-3 py-2 text-[12px] text-[var(--color-ink)]">
          {notice}
        </div>
      )}

      {section === "custom-mcp" && <CustomMcpPanel cp={cp} />}

      {section === "connectors" && (
        <div className="space-y-3">
          <p className="text-[12px] leading-5 text-[var(--color-ink-dim)]">
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="cp-input min-w-[12rem] flex-1 text-[12.5px]"
              placeholder={t("Search connectors…")}
              value={connectorQueryDraft}
              onChange={(e) => setConnectorQueryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setConnectorQuery(connectorQueryDraft.trim());
              }}
            />
            <button
              type="button"
              className="cp-btn-ghost py-1.5 text-[12px]"
              onClick={() => setConnectorQuery(connectorQueryDraft.trim())}
            >
              {t("Search")}
            </button>
            {(["all", "installed"] as ListTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={
                  connectorTab === tab
                    ? "cp-btn py-1 text-[11px]"
                    : "cp-btn-ghost py-1 text-[11px]"
                }
                onClick={() => {
                  setConnectorTab(tab);
                  setSelected(null);
                }}
              >
                {tab === "all" ? t("All") : t("Installed")}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {connectors.map((c) => (
              <button
                key={c.id}
                type="button"
                className="flex flex-col rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-left hover:border-[var(--color-accent)]"
                onClick={() => {
                  setSelected(c);
                  setValues({});
                  setEditCredentials(false);
                  setError(undefined);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--color-ink)]">{c.name}</span>
                  {statusBadge(c)}
                </span>
                <span className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                  {c.description}
                </span>
              </button>
            ))}
          </div>
          {connectors.length === 0 && (
            <p className="text-[12px] text-[var(--color-ink-faint)]">{t("No connectors found.")}</p>
          )}
          {connectors.length < connectorsTotal && (
            <button
              type="button"
              className="cp-btn-ghost w-full py-2 text-[12px]"
              onClick={() => void loadConnectors({ offset: connectors.length })}
            >
              {t("Load more")} ({connectors.length}/{connectorsTotal})
            </button>
          )}
          {selected && (
            <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-[var(--color-ink)]">{selected.name}</span>
                {statusBadge(selected)}
                {selected.authUrl && (
                  <a
                    className="text-[12px] text-[var(--color-accent)] underline"
                    href={selected.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Open authorisation")}
                  </a>
                )}
                {selected.docsUrl && (
                  <a
                    className="text-[12px] text-[var(--color-ink-faint)] underline"
                    href={selected.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Docs")}
                  </a>
                )}
              </div>
              {selected.status.installed ? (
                <>
                  <p className="mb-2 text-[11.5px] leading-4 text-[var(--color-ink-dim)]">
                    {[
                      selected.status.mcpName
                        ? `${t("MCP")}: ${selected.status.mcpName}`
                        : null,
                      selected.status.skillName
                        ? `${t("Skill")}: ${selected.status.skillName}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="cp-btn-ghost"
                      onClick={() => {
                        setSelected(null);
                        setEditCredentials(false);
                      }}
                    >
                      {t("Close")}
                    </button>
                    {selected.status.mcpName && (
                      <button
                        type="button"
                        className="cp-btn"
                        disabled={busy}
                        onClick={() => void toggleConnector(selected, !selected.status.enabled)}
                      >
                        {selected.status.enabled ? t("Disable") : t("Enable")}
                      </button>
                    )}
                    {selected.credentials.length > 0 && (
                      <button
                        type="button"
                        className="cp-btn-ghost"
                        onClick={() => {
                          setEditCredentials((v) => !v);
                          setValues({});
                        }}
                      >
                        {editCredentials ? t("Hide credentials") : t("Update credentials")}
                      </button>
                    )}
                  </div>
                  {editCredentials && (
                    <div className="mt-3 border-t border-[var(--color-edge-subtle)] pt-3">
                      <p className="mb-2 text-[11.5px] text-[var(--color-ink-faint)]">
                        {t("Leave blank to keep current value")}
                      </p>
                      {selected.credentials.map((f) => (
                        <label key={f.key} className="mb-2 block">
                          <span className="cp-eyebrow">{f.label}</span>
                          <input
                            className="cp-input mt-0.5 w-full font-mono text-[12px]"
                            type={f.secret ? "password" : "text"}
                            placeholder={t("Leave blank to keep current value")}
                            value={values[f.key] ?? ""}
                            onChange={(e) =>
                              setValues((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          className="cp-btn"
                          disabled={busy}
                          onClick={() => void saveConnector()}
                        >
                          {t("Save changes")}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-3 text-[11.5px] leading-4 text-[var(--color-warn)]">
                    {selected.securityNotice}
                  </p>
                  {selected.credentials.map((f) => (
                    <label key={f.key} className="mb-2 block">
                      <span className="cp-eyebrow">{f.label}</span>
                      <input
                        className="cp-input mt-0.5 w-full font-mono text-[12px]"
                        type={f.secret ? "password" : "text"}
                        placeholder={f.placeholder}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="cp-btn-ghost"
                      onClick={() => setSelected(null)}
                    >
                      {t("Cancel")}
                    </button>
                    <button
                      type="button"
                      className="cp-btn"
                      disabled={busy}
                      onClick={() => void saveConnector()}
                    >
                      {t("Install connector")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {section === "skills" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="cp-btn"
              disabled={busy || !onComposePrompt}
              onClick={() => void startCreateViaSkillCreator()}
            >
              {t("Create skill")}
            </button>
            <button
              type="button"
              className="cp-btn-ghost"
              disabled={busy}
              onClick={() => skillFileRef.current?.click()}
            >
              {t("Upload skill")}
            </button>
            <input
              ref={skillFileRef}
              type="file"
              accept=".zip,.7z,.tar,.tgz,.gz,application/zip,application/x-7z-compressed,application/gzip,application/x-tar"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadSkillArchive(file);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="cp-input min-w-[12rem] flex-1 text-[12.5px]"
              placeholder={t("Search skills…")}
              value={skillQueryDraft}
              onChange={(e) => setSkillQueryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSkillQuery(skillQueryDraft.trim());
              }}
            />
            <button
              type="button"
              className="cp-btn-ghost py-1.5 text-[12px]"
              onClick={() => setSkillQuery(skillQueryDraft.trim())}
            >
              {t("Search")}
            </button>
            {(["all", "installed"] as ListTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={
                  skillTab === tab ? "cp-btn py-1 text-[11px]" : "cp-btn-ghost py-1 text-[11px]"
                }
                onClick={() => setSkillTab(tab)}
              >
                {tab === "all" ? t("All") : t("Installed")}
              </button>
            ))}
          </div>
          {editingSkill && (
            <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-[var(--color-ink)]">{editingSkill}</span>
                <span className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-dim)]">
                  {skillActiveFile}
                </span>
                {skillEditHint && (
                  <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-ink-faint)]">
                    {skillEditHint}
                  </span>
                )}
              </div>
              <div className="mb-2 flex max-h-28 flex-wrap gap-1 overflow-auto">
                {skillFiles.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={
                      f === skillActiveFile
                        ? "rounded-md bg-[var(--color-accent)] px-2 py-0.5 font-mono text-[10.5px] text-white"
                        : "rounded-md border border-[var(--color-edge-subtle)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-ink-dim)] hover:border-[var(--color-accent)]"
                    }
                    disabled={busy}
                    onClick={() => void switchSkillFile(f)}
                    title={f}
                  >
                    {f}
                  </button>
                ))}
                <button
                  type="button"
                  className="rounded-md border border-dashed border-[var(--color-edge)] px-2 py-0.5 text-[10.5px] text-[var(--color-accent)] hover:border-[var(--color-accent)]"
                  disabled={busy}
                  onClick={() => {
                    setAddingSkillFile(true);
                    setNewSkillFilePath((p) => p || "templates/");
                  }}
                >
                  + {t("Add file")}
                </button>
              </div>
              {addingSkillFile && (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className="cp-input min-w-[12rem] flex-1 font-mono text-[12px]"
                    placeholder="templates/example.md"
                    value={newSkillFilePath}
                    onChange={(e) => setNewSkillFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addSkillFile();
                      if (e.key === "Escape") {
                        setAddingSkillFile(false);
                        setNewSkillFilePath("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="cp-btn py-1 text-[11px]"
                    disabled={busy}
                    onClick={() => void addSkillFile()}
                  >
                    {t("Create")}
                  </button>
                  <button
                    type="button"
                    className="cp-btn-ghost py-1 text-[11px]"
                    onClick={() => {
                      setAddingSkillFile(false);
                      setNewSkillFilePath("");
                    }}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              )}
              <p className="mb-1 text-[11px] text-[var(--color-ink-faint)]">
                {t("Switch files to edit templates / references next to SKILL.md. Use Add file for new paths.")}
              </p>
              <textarea
                className="cp-input mt-1 min-h-56 w-full font-mono text-[11.5px]"
                value={skillMarkdown}
                onChange={(e) => setSkillMarkdown(e.target.value)}
                spellCheck={false}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="cp-btn-ghost"
                  onClick={() => {
                    setEditingSkill(null);
                    setSkillMarkdown("");
                    setSkillFiles(["SKILL.md"]);
                    setSkillActiveFile("SKILL.md");
                    setAddingSkillFile(false);
                    setNewSkillFilePath("");
                  }}
                >
                  {t("Cancel")}
                </button>
                <button type="button" className="cp-btn" disabled={busy} onClick={() => void saveEditSkill()}>
                  {t("Save changes")}
                </button>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            {skills.map((sk) => (
              <div
                key={sk.name}
                className="flex items-start gap-2 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-ink)]">{sk.name}</span>
                    {sk.state === "available" ? (
                      <span className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]">
                        {t("Not installed")}
                      </span>
                    ) : sk.enabled ? (
                      <span className="rounded bg-[var(--color-add)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-add)]">
                        {t("Enabled")}
                      </span>
                    ) : (
                      <span className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-warn)]">
                        {t("Disabled")}
                      </span>
                    )}
                    {sk.source && (
                      <span className="text-[10px] text-[var(--color-ink-faint)]">[{sk.source}]</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                    {sk.description}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {sk.state === "available" ? (
                    <button
                      type="button"
                      className="cp-btn py-1 text-[11px]"
                      disabled={busy || !sk.connectorId}
                      onClick={() => void installSkill(sk)}
                    >
                      {t("Install")}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="cp-btn-ghost py-1 text-[11px]"
                        disabled={busy}
                        onClick={() => void openEditSkill(sk)}
                      >
                        {t("Edit")}
                      </button>
                      <button
                        type="button"
                        className="cp-btn-ghost py-1 text-[11px]"
                        disabled={busy}
                        onClick={() => void toggleSkill(sk, !sk.enabled)}
                      >
                        {sk.enabled ? t("Disable") : t("Enable")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {skills.length === 0 && (
              <p className="text-[12px] text-[var(--color-ink-faint)]">{t("No skills found.")}</p>
            )}
            {skills.length < skillsTotal && (
              <button
                type="button"
                className="cp-btn-ghost w-full py-2 text-[12px]"
                onClick={() => void loadSkills({ offset: skills.length })}
              >
                {t("Load more")} ({skills.length}/{skillsTotal})
              </button>
            )}
          </div>
        </div>
      )}

      {section === "general" && (
        <div className="space-y-3">
          <div className="divide-y divide-[var(--color-edge-subtle)] overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
            <GeneralRow title={t("Language")} hint={t("Interface language")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={getLocale()}
                aria-label={t("Language")}
                onChange={(e) => setLocale(e.target.value as Locale, { persist: true })}
              >
                <option value="zh">{t("Chinese")}</option>
                <option value="en">{t("English")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Theme")} hint={t("Color scheme")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={theme}
                aria-label={t("Theme")}
                onChange={(e) => onTheme(e.target.value as Theme)}
              >
                <option value="light">{t("Light")}</option>
                <option value="dark">{t("Dark")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Layout")} hint={t("Primary UI layout")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={layout === "embedded" ? "web" : layout}
                aria-label={t("Layout")}
                onChange={(e) => onLayout(e.target.value as Layout)}
              >
                <option value="web">{t("Code view")}</option>
                <option value="agent">{t("Agent view")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Permission mode")} hint={t("How tools ask for approval")}>
              <select
                className="cp-input w-auto min-w-[9.5rem] shrink-0 py-1.5 text-[12.5px]"
                value={permissionMode}
                aria-label={t("Permission mode")}
                onChange={(e) => {
                  const next = e.target.value as PermissionMode;
                  setPermissionModeState(next);
                  savePermissionMode(next);
                  setNotice(t("Permission mode saved — applies on next connect."));
                }}
              >
                <option value="ask">{t("Ask every time")}</option>
                <option value="auto-edit">{t("Auto-edit")}</option>
                <option value="yolo">{t("Full access (YOLO)")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Default mode")} hint={t("Collaboration mode for new sessions")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={state.agentMode}
                aria-label={t("Default mode")}
                onChange={(e) => {
                  const next = e.target.value as AgentMode;
                  saveDefaultAgentMode(next);
                  void cp.setMode(next);
                }}
              >
                <option value="chat">{t("Ask")}</option>
                <option value="plan">{t("Plan")}</option>
                <option value="agent">{t("Agent")}</option>
              </select>
            </GeneralRow>
            {lanAccess !== null && (
              <GeneralRow
                title={t("Allow phone access (same Wi‑Fi)")}
                hint={t("Lets a phone on your network reach the engine via the QR code. Access still requires the one-time pairing. Toggling restarts the engine.")}
              >
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--color-ink-dim)]">
                  <input
                    type="checkbox"
                    checked={lanAccess}
                    disabled={lanBusy}
                    onChange={(e) => void toggleLanAccess(e.target.checked)}
                  />
                  {lanBusy ? `${t("Applying")}…` : lanAccess ? t("On") : t("Off")}
                </label>
              </GeneralRow>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
            <GeneralRow title={t("Engine updates")} hint={updateInfo ? `${t("Current")}: ${updateInfo.current}${updateInfo.available ? ` → ${updateInfo.latest ?? ""}` : ` · ${t("up to date")}`}` : t("Check for a newer engine")}>
              <div className="flex shrink-0 items-center gap-2">
                {updateInfo?.available && updateInfo.canAutoApply && (
                  <button type="button" className="cp-btn py-1.5 text-[12px]" disabled={updateBusy} onClick={() => void applyUpdate()}>
                    {t("Install update")}
                  </button>
                )}
                <button type="button" className="cp-btn-ghost py-1.5 text-[12px]" disabled={updateBusy || state.connection !== "connected"} onClick={() => void checkUpdate()}>
                  {updateBusy ? `${t("Checking")}…` : t("Check for updates")}
                </button>
              </div>
            </GeneralRow>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-ink)]">{t("Image generation")}</div>
                <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                  {t("Configure an image model endpoint. The image tool is only available when this is set.")}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--color-ink-dim)]">
                <input
                  type="checkbox"
                  checked={imgGen.enabled}
                  onChange={(e) => setImgGen((p) => ({ ...p, enabled: e.target.checked }))}
                />
                {t("Enabled")}
              </label>
            </div>
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="cp-eyebrow">{t("Base URL")}</span>
                <input
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder="https://api.openai.com/v1"
                  value={imgGen.baseURL}
                  onChange={(e) => setImgGen((p) => ({ ...p, baseURL: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="cp-eyebrow">{t("API key")}</span>
                <input
                  type="password"
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder={imgGen.hasApiKey ? "••••••• (" + t("saved") + ")" : ""}
                  value={imgGen.apiKey}
                  onChange={(e) => setImgGen((p) => ({ ...p, apiKey: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="cp-eyebrow">{t("Model")}</span>
                <input
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder="gpt-image-1"
                  value={imgGen.model}
                  onChange={(e) => setImgGen((p) => ({ ...p, model: e.target.value }))}
                />
              </label>
              <button
                type="button"
                className="cp-btn py-1.5 text-[12px]"
                disabled={busy || state.connection !== "connected"}
                onClick={() => void saveImageGen()}
              >
                {t("Save changes")}
              </button>
            </div>
          </div>
        </div>
      )}

      {section === "remote" && (
        <div className="space-y-3">
          {cp.workspaces.length > 1 && (
            <div className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
              <div className="text-[13px] font-medium text-[var(--color-ink)]">
                {t("Workspaces to authorize")}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                {t("The phone sees exactly the workspaces you tick. The active one is always included.")}
              </div>
              <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                {cp.workspaces.map((ws) => {
                  const isActive = ws === state.cwd;
                  const label = ws.split("/").filter(Boolean).pop() || ws;
                  return (
                    <label
                      key={ws}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-[var(--color-surface-hover)]"
                      title={ws}
                    >
                      <input
                        type="checkbox"
                        checked={pairCwds.includes(ws)}
                        disabled={isActive}
                        onChange={() => togglePairCwd(ws)}
                      />
                      <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{label}</span>
                      {isActive && (
                        <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                          {t("active")}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <button
            type="button"
            className="cp-btn"
            disabled={busy || state.connection !== "connected"}
            onClick={() => void mintQr()}
          >
            {t("Generate one-time QR")}
          </button>
          {qr && (
            <div className="flex flex-col items-center rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] p-4">
              <img src={qr.qrDataUrl} alt="QR" className="h-[200px] w-[200px] rounded-lg bg-white p-2" />
              <p className="mt-2 text-center text-[11.5px] text-[var(--color-ink-dim)]">
                {t("Scan the QR with your phone — one-time only.")}
              </p>
              <div className="mt-2 text-[12px] text-[var(--color-ink)]">
                {t("Code")}: <span className="font-mono">{qr.code}</span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
                {t("Expires")}: {new Date(qr.expiresAt).toLocaleTimeString()}
              </div>
              <p className="mt-2 max-w-sm break-all text-center font-mono text-[10px] text-[var(--color-ink-faint)]">
                {qr.url}
              </p>
            </div>
          )}
          <button
            type="button"
            className="cp-btn-ghost text-[var(--color-remove)]"
            disabled={busy}
            onClick={() => void revokeAllRemote()}
          >
            {t("Revoke all remote access")}
          </button>
        </div>
      )}

      {section === "schedule" && (
        <div className="space-y-3">
          <label className="block">
            <span className="cp-eyebrow">{t("Title")}</span>
            <input className="cp-input mt-0.5 w-full" value={idleTitle} onChange={(e) => setIdleTitle(e.target.value)} />
          </label>
          <label className="block">
            <span className="cp-eyebrow">{t("Prompt")}</span>
            <textarea
              className="cp-input mt-0.5 min-h-24 w-full text-[12.5px]"
              value={idlePrompt}
              onChange={(e) => setIdlePrompt(e.target.value)}
              placeholder={t("e.g. Summarize unread Feishu docs and draft a status update")}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="cp-eyebrow">{t("Task type")}</span>
              <select
                className="cp-input mt-0.5 w-full text-[12.5px]"
                value={taskKind}
                onChange={(e) => setTaskKind(e.target.value as "idle" | "once" | "daily" | "interval")}
              >
                <option value="idle">{t("When idle")}</option>
                <option value="once">{t("Once")}</option>
                <option value="daily">{t("Daily")}</option>
                <option value="interval">{t("Every N minutes")}</option>
              </select>
            </label>
            {taskKind === "once" && (
              <label className="block">
                <span className="cp-eyebrow">{t("Run at")}</span>
                <input
                  type="datetime-local"
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  value={taskOnceAt}
                  onChange={(e) => setTaskOnceAt(e.target.value)}
                />
              </label>
            )}
            {taskKind === "daily" && (
              <label className="block">
                <span className="cp-eyebrow">{t("Run at")}</span>
                <input
                  type="time"
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  value={taskAt}
                  onChange={(e) => setTaskAt(e.target.value)}
                />
              </label>
            )}
            {taskKind === "interval" && (
              <label className="block">
                <span className="cp-eyebrow">{t("Every (minutes)")}</span>
                <input
                  type="number"
                  min={1}
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  value={taskEvery}
                  onChange={(e) => setTaskEvery(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="cp-eyebrow">{t("Model")}</span>
              <select
                className="cp-input mt-0.5 w-full text-[12.5px]"
                value={idleModelKey}
                onChange={(e) => setIdleModelKey(e.target.value)}
              >
                <option value="">{t("Host default model")}</option>
                {scheduleModels.map((m) => (
                  <option key={m.id} value={`${m.providerId}::${m.model}`}>
                    {m.providerLabel}: {m.model}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="cp-eyebrow">{t("Tool mode")}</span>
              <select
                className="cp-input mt-0.5 w-full text-[12.5px]"
                value={idleAgentMode}
                onChange={(e) => setIdleAgentMode(e.target.value as "chat" | "plan" | "agent")}
              >
                <option value="agent">{t("Agent (full tools)")}</option>
                <option value="plan">{t("Plan")}</option>
                <option value="chat">{t("Chat (read-leaning)")}</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {editingTaskId ? (
              <>
                <button
                  type="button"
                  className="cp-btn"
                  disabled={busy || !idlePrompt.trim()}
                  onClick={() => void saveEditIdle()}
                >
                  {t("Save changes")}
                </button>
                <button type="button" className="cp-btn-ghost" disabled={busy} onClick={cancelEditIdle}>
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="cp-btn"
                disabled={busy || !idlePrompt.trim()}
                onClick={() => void addIdle()}
              >
                {taskKind === "idle" ? t("Add idle task") : t("Add scheduled task")}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {tasks.map((task) => {
              const neverRun = !task.lastRunAt;
              const schedule =
                task.kind === "once"
                  ? task.runAt
                    ? new Date(task.runAt).toLocaleString()
                    : t("Once")
                  : task.kind === "daily"
                    ? `${t("Daily")} ${task.at ?? ""}`.trim()
                    : task.kind === "interval"
                      ? `${t("Every N minutes")} (${task.everyMinutes ?? "?"})`
                      : t("When idle");
              return (
                <div
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] px-2.5 py-2 text-[12px]"
                >
                  <span className={task.enabled ? "text-[var(--color-add)]" : "text-[var(--color-ink-faint)]"}>
                    {task.enabled ? "●" : "○"}
                  </span>
                  <span className="min-w-0 flex-1 text-[var(--color-ink)]">
                    <span className="block truncate">
                      {task.title}{" "}
                      <span className="text-[var(--color-ink-faint)]">
                        [{schedule}
                        {task.model ? ` · ${task.model}` : ""}
                        {task.agentMode && task.agentMode !== "agent" ? ` · ${task.agentMode}` : ""}]
                      </span>
                      {neverRun ? (
                        <span className="ml-1 text-[10px] text-[var(--color-accent)]">{t("pending")}</span>
                      ) : (
                        <span
                          className={`ml-1 text-[10px] ${
                            task.lastStatus === "error"
                              ? "text-[var(--color-remove)]"
                              : "text-[var(--color-ink-faint)]"
                          }`}
                        >
                          {task.lastStatus ?? "ran"}
                        </span>
                      )}
                    </span>
                    {!neverRun && (
                      <span className="mt-0.5 block truncate text-[10px] text-[var(--color-ink-faint)]">
                        {t("Last run")}: {new Date(task.lastRunAt as number).toLocaleString()}
                        {typeof task.runCount === "number" ? ` · ${t("Runs")}: ${task.runCount}` : ""}
                        {task.lastStatus === "error" && task.lastError ? ` · ${task.lastError}` : ""}
                      </span>
                    )}
                  </span>
                  {neverRun && (
                    <button
                      type="button"
                      className="cp-btn-ghost py-0.5 text-[11px]"
                      disabled={busy}
                      onClick={() => beginEditIdle(task)}
                    >
                      {t("Edit")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="cp-btn-ghost py-0.5 text-[11px] text-[var(--color-remove)]"
                    disabled={busy}
                    onClick={() => void removeTask(task.id)}
                  >
                    {t("Remove")}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function GeneralRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--color-ink)]">{title}</div>
        <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">{hint}</div>
      </div>
      {children}
    </div>
  );
}
