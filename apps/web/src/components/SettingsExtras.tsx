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
  idleAfterMs?: number;
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
  const [qr, setQr] = useState<{
    url: string;
    code: string;
    expiresAt: number;
    qrDataUrl: string;
  } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [idlePrompt, setIdlePrompt] = useState("");
  const [idleTitle, setIdleTitle] = useState("闲时任务");
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
  }, [section, connectorQuery, connectorTab, skillQuery, skillTab, state.connection]);

  // Notices are section-local; clear when switching tabs so QR tips don't leak.
  useEffect(() => {
    setNotice(undefined);
    setError(undefined);
    setSelected(null);
    setEditCredentials(false);
    setValues({});
  }, [section]);

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

  const mintQr = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const serveUrl = `${window.location.protocol}//${window.location.host}`;
      const r = await client.mintRemotePairing({
        serveUrl,
        cwd: state.cwd || undefined,
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
        title: idleTitle.trim() || "闲时任务",
        prompt: idlePrompt.trim(),
        cwd: state.cwd || undefined,
        kind: "idle",
        idleAfterMs: 10 * 60 * 1000,
        model,
        providerId,
        agentMode: idleAgentMode,
      });
      setIdlePrompt("");
      setEditingTaskId(null);
      await reload();
      setNotice(t("Idle task queued — runs when the engine is free."));
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
  };

  const saveEditIdle = async (): Promise<void> => {
    if (!editingTaskId || !idlePrompt.trim()) return;
    setBusy(true);
    try {
      const { model, providerId } = parseIdleModel();
      await client.updateScheduledTask(editingTaskId, {
        title: idleTitle.trim() || "闲时任务",
        prompt: idlePrompt.trim(),
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
          </div>
        </div>
      )}

      {section === "remote" && (
        <div className="space-y-3">
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
                {t("Add idle task")}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {tasks.map((task) => {
              const neverRun = !task.lastRunAt;
              return (
                <div
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] px-2.5 py-2 text-[12px]"
                >
                  <span className={task.enabled ? "text-[var(--color-add)]" : "text-[var(--color-ink-faint)]"}>
                    {task.enabled ? "●" : "○"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">
                    {task.title}{" "}
                    <span className="text-[var(--color-ink-faint)]">
                      [{task.kind}
                      {task.model ? ` · ${task.model}` : ""}
                      {task.agentMode && task.agentMode !== "agent" ? ` · ${task.agentMode}` : ""}]
                    </span>
                    {neverRun ? (
                      <span className="ml-1 text-[10px] text-[var(--color-accent)]">{t("pending")}</span>
                    ) : (
                      <span className="ml-1 text-[10px] text-[var(--color-ink-faint)]">
                        {task.lastStatus ?? "ran"}
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
