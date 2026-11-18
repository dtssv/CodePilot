/**
 * Shared state, effects, and handlers for Settings extras panels.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PermissionMode } from "@codepilot/core";

import type { Codepilot } from "../../state/useCodepilot.js";
import { describeError } from "../../protocol/client.js";
import type { SearchEngineInfo } from "../../protocol/client.js";
import { t } from "../../i18n.js";
import { loadPermissionMode } from "../../prefs.js";
import { parseHeaderLines, resolveServeUrl } from "./helpers.js";
import {
  PAGE_SIZE,
  type Connector,
  type ManagedSkill,
  type ScheduleModelOpt,
  type SettingsExtraSection,
  type ListTab,
  type Task,
} from "./types.js";

export type UseSettingsExtrasParams = {
  cp: Codepilot;
  section: SettingsExtraSection;
  onComposePrompt?: (text: string) => void;
};

export function useSettingsExtras({
  cp,
  section,
  onComposePrompt,
}: UseSettingsExtrasParams) {
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
  const [skillSourceDraft, setSkillSourceDraft] = useState("");
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
  // Web search: catalog pick (`choice` = engine id / duckduckgo / "__custom__"),
  // apiKey + env for `${VAR}` fills, and an editable custom template draft.
  const [search, setSearch] = useState<{
    engines: SearchEngineInfo[];
    choice: string;
    apiKey: string;
    hasApiKey: boolean;
    customUrl: string;
    env: Record<string, string>;
    customDraft: {
      method: "GET" | "POST";
      url: string;
      headersText: string;
      body: string;
      resultsPath: string;
      titleField: string;
      urlField: string;
      snippetField: string;
    };
  }>({
    engines: [],
    choice: "duckduckgo",
    apiKey: "",
    hasApiKey: false,
    customUrl: "",
    env: {},
    customDraft: {
      method: "GET",
      url: "",
      headersText: "",
      body: "",
      resultsPath: "",
      titleField: "title",
      urlField: "url",
      snippetField: "snippet",
    },
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
  // OS sandbox mode for tool execution (bash / file writes). Mirrors the core
  // `sandbox.mode` config; `null` while loading. Changing it persists to the
  // user config and hot-applies to the active session.
  const [sandboxMode, setSandboxMode] = useState<"off" | "workspace-write" | "read-only" | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  // Workspaces to authorize for the next QR (the phone lists exactly these).
  // Defaults to the active workspace; the user can tick more before minting.
  const [pairCwds, setPairCwds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [idlePrompt, setIdlePrompt] = useState("");
  const [idleTitle, setIdleTitle] = useState("闲时任务");
  const [taskKind, setTaskKind] = useState<"idle" | "once" | "daily" | "weekly" | "interval" | "cron">("idle");
  const [taskAt, setTaskAt] = useState("09:00");
  const [taskOnceAt, setTaskOnceAt] = useState(""); // datetime-local value for one-time tasks
  const [taskEvery, setTaskEvery] = useState(60);
  const [taskCron, setTaskCron] = useState("0 9 * * *");
  const [taskTimezone, setTaskTimezone] = useState("");
  const [taskWeekdays, setTaskWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
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
          if (cfg.webSearch) {
            const ws = cfg.webSearch;
            const engines = ws.engines ?? [];
            // Prefer stored engineId; else match catalog by URL; else free-form custom.
            let choice = ws.provider ?? "duckduckgo";
            if (ws.provider === "custom") {
              if (ws.engineId && engines.some((e) => e.id === ws.engineId)) {
                choice = ws.engineId;
              } else if (ws.customUrl) {
                const match = engines.find((e) => e.template.url === ws.customUrl);
                choice = match?.id ?? "__custom__";
              } else {
                choice = "__custom__";
              }
            }
            const c = ws.custom;
            const headersText = c?.headers
              ? Object.entries(c.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")
              : "";
            setSearch({
              engines,
              choice,
              apiKey: "",
              hasApiKey: !!ws.hasApiKey,
              customUrl: ws.customUrl ?? "",
              env: { ...(ws.env ?? {}) },
              customDraft: {
                method: c?.method === "POST" ? "POST" : "GET",
                url: c?.url ?? "",
                headersText,
                body: c?.body ?? "",
                resultsPath: c?.resultsPath ?? "",
                titleField: c?.fields?.title ?? "title",
                urlField: c?.fields?.url ?? "url",
                snippetField: c?.fields?.snippet ?? "snippet",
              },
            });
          }
          setSandboxMode(cfg.sandbox?.mode ?? "workspace-write");
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

  const changeSandboxMode = async (
    next: "off" | "workspace-write" | "read-only",
  ): Promise<void> => {
    setSandboxBusy(true);
    setError(undefined);
    setNotice(undefined);
    const prev = sandboxMode;
    setSandboxMode(next); // optimistic
    try {
      const r = await client.setSandbox({
        mode: next,
        sessionId: state.sessionId || undefined,
      });
      setSandboxMode(r.sandbox.mode);
      if (next === "off") {
        setNotice(
          t(
            "Sandbox OFF — tool commands and file writes run WITHOUT OS confinement. Only use on trusted machines.",
          ),
        );
      } else if (r.sandbox.unavailable) {
        const base = t(
          "Sandbox set, but no OS sandbox backend is available on this host — bash will refuse to run (fail-closed). Install the backend or set the sandbox to off.",
        );
        // Prefer the server's platform-specific install guidance when present.
        setNotice(r.sandbox.reason?.hint ? `${base} ${r.sandbox.reason.hint}` : base);
      } else {
        setNotice(
          next === "read-only"
            ? t("Sandbox set to read-only — the agent cannot write files or run mutating commands.")
            : t("Sandbox set to workspace-write — writes are confined to the workspace."),
        );
      }
    } catch (err) {
      setSandboxMode(prev); // revert on failure
      setError(describeError(err));
    } finally {
      setSandboxBusy(false);
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

  const installSkillFromSource = async (): Promise<void> => {
    const source = skillSourceDraft.trim();
    if (!source) return;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const r = await client.installSkillSource(source);
      setNotice(r.message);
      setSkillSourceDraft("");
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
        ...(taskKind === "weekly" ? { at: taskAt, daysOfWeek: taskWeekdays } : {}),
        ...(taskKind === "interval" ? { everyMinutes: Math.max(1, taskEvery) } : {}),
        ...(taskKind === "cron" ? { cron: taskCron.trim() } : {}),
        ...((taskKind === "daily" || taskKind === "weekly" || taskKind === "cron") && taskTimezone.trim()
          ? { timezone: taskTimezone.trim() }
          : {}),
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
    if (
      task.kind === "idle" || task.kind === "once" || task.kind === "daily" ||
      task.kind === "weekly" || task.kind === "interval" || task.kind === "cron"
    ) {
      setTaskKind(task.kind);
    }
    if (task.at) setTaskAt(task.at);
    if (task.cron) setTaskCron(task.cron);
    if (task.timezone) setTaskTimezone(task.timezone);
    if (Array.isArray(task.daysOfWeek)) setTaskWeekdays(task.daysOfWeek);
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
        ...(taskKind === "weekly" ? { at: taskAt, daysOfWeek: taskWeekdays } : {}),
        ...(taskKind === "interval" ? { everyMinutes: Math.max(1, taskEvery) } : {}),
        ...(taskKind === "cron" ? { cron: taskCron.trim() } : {}),
        ...((taskKind === "daily" || taskKind === "weekly" || taskKind === "cron") && taskTimezone.trim()
          ? { timezone: taskTimezone.trim() }
          : {}),
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

  // The currently selected catalog engine (if the choice is a catalog id).
  const selectedEngine = search.engines.find((e) => e.id === search.choice);

  const saveWebSearch = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      let patch: Parameters<typeof client.setWebSearch>[0];
      if (search.choice === "duckduckgo") {
        patch = { provider: "duckduckgo" };
      } else if (search.choice === "__custom__") {
        const headers = parseHeaderLines(search.customDraft.headersText);
        const url = search.customDraft.url.trim();
        if (!url) throw new Error(t("Custom search URL is required"));
        patch = {
          provider: "custom",
          engineId: null,
          apiKey: search.apiKey,
          env: Object.keys(search.env).length > 0 ? search.env : null,
          custom: {
            method: search.customDraft.method,
            url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(search.customDraft.body.trim() ? { body: search.customDraft.body } : {}),
            ...(search.customDraft.resultsPath.trim()
              ? { resultsPath: search.customDraft.resultsPath.trim() }
              : {}),
            fields: {
              title: search.customDraft.titleField.trim() || "title",
              url: search.customDraft.urlField.trim() || "url",
              snippet: search.customDraft.snippetField.trim() || "snippet",
            },
          },
        };
      } else if (selectedEngine) {
        // Catalog engine → write its template as the custom backend; apiKey
        // fills the engine's keyEnvVar, and `env` fills any other ${VAR}s
        // (e.g. SEARXNG_URL).
        patch = {
          provider: "custom",
          engineId: selectedEngine.id,
          apiKey: search.apiKey,
          env: Object.keys(search.env).length > 0 ? search.env : null,
          custom: selectedEngine.template,
        };
      } else {
        patch = { provider: search.choice as "brave" | "serper" | "google", apiKey: search.apiKey };
      }
      const r = await client.setWebSearch(patch);
      setSearch((prev) => ({
        ...prev,
        apiKey: "",
        hasApiKey: r.webSearch.hasApiKey,
        customUrl: r.webSearch.customUrl ?? prev.customUrl,
        env: { ...(r.webSearch.env ?? {}) },
        customDraft:
          r.webSearch.custom != null
            ? {
                method: r.webSearch.custom.method === "POST" ? "POST" : "GET",
                url: r.webSearch.custom.url ?? "",
                headersText: r.webSearch.custom.headers
                  ? Object.entries(r.webSearch.custom.headers)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join("\n")
                  : "",
                body: r.webSearch.custom.body ?? "",
                resultsPath: r.webSearch.custom.resultsPath ?? "",
                titleField: r.webSearch.custom.fields?.title ?? "title",
                urlField: r.webSearch.custom.fields?.url ?? "url",
                snippetField: r.webSearch.custom.fields?.snippet ?? "snippet",
              }
            : prev.customDraft,
      }));
      setNotice(t("Search settings saved — applies on next session."));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return {
    state,
    error,
    notice,
    connectors,
    connectorsTotal,
    connectorTab,
    connectorQueryDraft,
    setConnectorQueryDraft,
    setConnectorQuery,
    setConnectorTab,
    setSelected,
    setValues,
    setEditCredentials,
    setError,
    selected,
    values,
    editCredentials,
    busy,
    loadConnectors,
    saveConnector,
    toggleConnector,
    startCreateViaSkillCreator,
    skillFileRef,
    uploadSkillArchive,
    skillSourceDraft,
    setSkillSourceDraft,
    installSkillFromSource,
    skillQueryDraft,
    setSkillQueryDraft,
    setSkillQuery,
    skillTab,
    setSkillTab,
    editingSkill,
    skillActiveFile,
    skillEditHint,
    skillFiles,
    skillMarkdown,
    setSkillMarkdown,
    addingSkillFile,
    setAddingSkillFile,
    newSkillFilePath,
    setNewSkillFilePath,
    switchSkillFile,
    addSkillFile,
    setEditingSkill,
    setSkillFiles,
    setSkillActiveFile,
    saveEditSkill,
    skills,
    installSkill,
    openEditSkill,
    toggleSkill,
    skillsTotal,
    loadSkills,
    permissionMode,
    setPermissionModeState,
    setNotice,
    lanAccess,
    lanBusy,
    toggleLanAccess,
    sandboxMode,
    sandboxBusy,
    changeSandboxMode,
    updateInfo,
    updateBusy,
    applyUpdate,
    checkUpdate,
    imgGen,
    setImgGen,
    saveImageGen,
    search,
    setSearch,
    selectedEngine,
    saveWebSearch,
    pairCwds,
    togglePairCwd,
    mintQr,
    qr,
    revokeAllRemote,
    idleTitle,
    setIdleTitle,
    idlePrompt,
    setIdlePrompt,
    taskKind,
    setTaskKind,
    taskOnceAt,
    setTaskOnceAt,
    taskAt,
    setTaskAt,
    taskEvery,
    setTaskEvery,
    taskCron,
    setTaskCron,
    taskWeekdays,
    setTaskWeekdays,
    taskTimezone,
    setTaskTimezone,
    idleModelKey,
    setIdleModelKey,
    idleAgentMode,
    setIdleAgentMode,
    scheduleModels,
    editingTaskId,
    saveEditIdle,
    cancelEditIdle,
    addIdle,
    tasks,
    beginEditIdle,
    removeTask,
  };
}
