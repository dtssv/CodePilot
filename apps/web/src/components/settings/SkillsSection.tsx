import type React from "react";
import { t } from "../../i18n.js";
import type { ListTab, ManagedSkill } from "./types.js";

export type SkillsSectionProps = {
  onComposePrompt?: (text: string) => void;
  busy: boolean;
  startCreateViaSkillCreator: () => Promise<void>;
  skillFileRef: React.RefObject<HTMLInputElement>;
  uploadSkillArchive: (file: File) => Promise<void>;
  skillSourceDraft: string;
  setSkillSourceDraft: (v: string) => void;
  installSkillFromSource: () => Promise<void>;
  skillQueryDraft: string;
  setSkillQueryDraft: (v: string) => void;
  setSkillQuery: (v: string) => void;
  skillTab: ListTab;
  setSkillTab: (tab: ListTab) => void;
  editingSkill: string | null;
  skillActiveFile: string;
  skillEditHint: string | undefined;
  skillFiles: string[];
  skillMarkdown: string;
  setSkillMarkdown: (v: string) => void;
  addingSkillFile: boolean;
  setAddingSkillFile: (v: boolean) => void;
  newSkillFilePath: string;
  setNewSkillFilePath: React.Dispatch<React.SetStateAction<string>>;
  switchSkillFile: (relativePath: string) => Promise<void>;
  addSkillFile: () => Promise<void>;
  setEditingSkill: (v: string | null) => void;
  setSkillFiles: React.Dispatch<React.SetStateAction<string[]>>;
  setSkillActiveFile: (v: string) => void;
  saveEditSkill: () => Promise<void>;
  skills: ManagedSkill[];
  installSkill: (sk: ManagedSkill) => Promise<void>;
  openEditSkill: (sk: ManagedSkill) => Promise<void>;
  toggleSkill: (sk: ManagedSkill, enabled: boolean) => Promise<void>;
  skillsTotal: number;
  loadSkills: (opts?: { offset?: number }) => Promise<void>;
};

export function SkillsSection({
  onComposePrompt,
  busy,
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
}: SkillsSectionProps): React.ReactElement {
  return (
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
              className="cp-input min-w-[14rem] flex-1 text-[12.5px]"
              placeholder={t("Install from git URL or archive URL…")}
              value={skillSourceDraft}
              disabled={busy}
              onChange={(e) => setSkillSourceDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") void installSkillFromSource();
              }}
            />
            <button
              type="button"
              className="cp-btn-ghost py-1.5 text-[12px]"
              disabled={busy || !skillSourceDraft.trim()}
              onClick={() => void installSkillFromSource()}
            >
              {t("Install")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="cp-input min-w-[12rem] flex-1 text-[12.5px]"
              placeholder={t("Search skills…")}
              value={skillQueryDraft}
              onChange={(e) => setSkillQueryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
  );
}
