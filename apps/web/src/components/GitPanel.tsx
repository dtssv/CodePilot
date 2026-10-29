// Git controls embedded in the workspace panel: branch switch/create, stage,
// commit (with AI-generated message), push/pull/fetch. Respects .gitignore
// because every action shells out to the real `git` in the workspace.

import { useCallback, useEffect, useState } from "react";

import type { CodepilotClient } from "../protocol/client.js";
import { describeError } from "../protocol/client.js";
import { t } from "../i18n.js";
import { GitIcon, PlusIcon, RefreshIcon, SpinnerIcon, XIcon } from "./Icons.js";

type Branch = { name: string; current: boolean; upstream?: string; ahead?: number; behind?: number };
type GitFile = { path: string; index: string; worktree: string; status: string };

export function GitPanel({
  client,
  cwd,
  sessionId,
  onClose,
  onChanged,
}: {
  client: CodepilotClient;
  cwd: string;
  /** Active chat session, so AI commit messages reuse its reachable model. */
  sessionId?: string;
  onClose(): void;
  /** Called after any mutating action so the file tree / status can refresh. */
  onChanged?(): void;
}): React.ReactElement {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [files, setFiles] = useState<GitFile[]>([]);
  const [notRepo, setNotRepo] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [showBranches, setShowBranches] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);

  const staged = files.filter((f) => f.index !== " " && f.index !== "?");
  const unstaged = files.filter((f) => f.index === " " || f.index === "?");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const status = await client.gitStatus(cwd);
      // Drop bare directory entries (untracked dirs end with "/"); we show
      // files only, since committing an empty folder is pointless.
      setFiles(status.files.filter((f) => !f.path.endsWith("/")));
      setNotRepo(false);
      try {
        const b = await client.gitBranches(cwd);
        setBranches(b.branches);
        setTags(b.tags ?? []);
        setCurrent(b.detached ? status.branch : b.current);
      } catch {
        setCurrent(status.branch);
      }
    } catch (err) {
      const msg = describeError(err);
      // "not a git repository" → offer init.
      if (/not a git repository/i.test(msg)) {
        setNotRepo(true);
        setFiles([]);
        setBranches([]);
      } else {
        setError(msg);
      }
    }
  }, [client, cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const genMessage = async (): Promise<void> => {
    setBusy("genmsg");
    setError(null);
    try {
      const r = await client.gitCommitMessage(cwd, sessionId);
      setMessage(r.message);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="flex w-[26rem] min-w-[20rem] shrink-0 flex-col border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3">
        <GitIcon className="h-4 w-4 text-[var(--color-accent)]" />
        <span className="text-[13px] font-semibold text-[var(--color-ink)]">{t("Git")}</span>
        <button
          type="button"
          className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
          onClick={() => setShowBranches((v) => !v)}
          disabled={notRepo}
          title={t("Switch branch")}
        >
          {current || "—"}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="cp-icon-btn" title={t("Fetch")} disabled={!!busy || notRepo} onClick={() => void run("fetch", () => client.gitFetch(cwd))}>
            {busy === "fetch" ? <SpinnerIcon className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
          </button>
          <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && <div className="mx-3 mt-2 shrink-0 rounded-md bg-[var(--color-remove-dim)] px-2 py-1 text-[11px] text-[var(--color-remove)]">{error}</div>}
      {notice && <div className="mx-3 mt-2 shrink-0 rounded-md bg-[var(--color-add-dim)] px-2 py-1 text-[11px] text-[var(--color-add)]">{notice}</div>}

      {notRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-[12.5px] text-[var(--color-ink-dim)]">{t("This folder is not a Git repository.")}</div>
          <button type="button" className="cp-btn" disabled={busy === "init"} onClick={() => void run("init", () => client.gitInit(cwd))}>
            {busy === "init" ? `${t("Initializing")}…` : t("Initialize repository")}
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {showBranches && (
            <div className="border-b border-[var(--color-edge-subtle)] p-2">
              {/* New-branch action at the top: a button that reveals the input
                  on click, instead of an always-present input box. */}
              {creatingBranch ? (
                <div className="mb-2 flex items-center gap-1.5">
                  <input
                    autoFocus
                    className="cp-input min-w-0 flex-1 py-1 text-[12px]"
                    placeholder={t("New branch name")}
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setCreatingBranch(false); setNewBranch(""); }
                      if (e.key === "Enter" && newBranch.trim()) {
                        void run("checkout", async () => {
                          await client.gitCheckout(newBranch.trim(), true, cwd);
                          setNewBranch("");
                          setCreatingBranch(false);
                          setShowBranches(false);
                        });
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="cp-btn py-1 text-[11px]"
                    disabled={!newBranch.trim() || !!busy}
                    onClick={() => void run("checkout", async () => {
                      await client.gitCheckout(newBranch.trim(), true, cwd);
                      setNewBranch("");
                      setCreatingBranch(false);
                      setShowBranches(false);
                    })}
                  >
                    {t("Create")}
                  </button>
                  <button
                    type="button"
                    className="cp-btn-ghost py-1 text-[11px]"
                    disabled={!!busy}
                    onClick={() => { setCreatingBranch(false); setNewBranch(""); }}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="mb-2 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  disabled={!!busy}
                  onClick={() => setCreatingBranch(true)}
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t("New branch")}
                </button>
              )}
              <input
                className="cp-input mb-1.5 w-full py-1 text-[12px]"
                placeholder={t("Search branches…")}
                value={branchQuery}
                onChange={(e) => setBranchQuery(e.target.value)}
              />
              <ul className="space-y-0.5">
                {(() => {
                  const q = branchQuery.trim().toLowerCase();
                  const filtered = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
                  // Default view shows the 5 most-recent branches (server sorts
                  // by committerdate); searching widens to all matches.
                  const shown = q ? filtered : filtered.slice(0, 5);
                  if (shown.length === 0) {
                    return <li className="px-2 py-1 text-[11px] text-[var(--color-ink-faint)]">{t("No matching branches")}</li>;
                  }
                  return shown.map((b) => (
                    <li key={b.name}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] ${
                          b.current ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
                        }`}
                        disabled={b.current || !!busy}
                        onClick={() => void run("checkout", async () => {
                          await client.gitCheckout(b.name, false, cwd);
                          setShowBranches(false);
                          setBranchQuery("");
                        })}
                      >
                        {b.current && <span className="shrink-0 text-[var(--color-accent)]">✓</span>}
                        <span className="min-w-0 flex-1 truncate">{b.name}</span>
                        {b.current && <span className="shrink-0 rounded bg-[var(--color-accent)] px-1 text-[9px] text-white">{t("current")}</span>}
                        {b.ahead ? <span className="shrink-0 text-[10px] text-[var(--color-add)]">↑{b.ahead}</span> : null}
                        {b.behind ? <span className="shrink-0 text-[10px] text-[var(--color-warn)]">↓{b.behind}</span> : null}
                      </button>
                    </li>
                  ));
                })()}
              </ul>
              {/* Recent tags (newest first, top 5 unless searching). */}
              {(() => {
                const q = branchQuery.trim().toLowerCase();
                const matched = q ? tags.filter((tg) => tg.toLowerCase().includes(q)) : tags;
                const shown = q ? matched : matched.slice(0, 5);
                if (shown.length === 0) return null;
                return (
                  <>
                    <div className="cp-eyebrow mt-2 px-2 pb-1">{t("Tags")}</div>
                    <ul className="space-y-0.5">
                      {shown.map((tg) => (
                        <li key={tg}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
                            disabled={!!busy}
                            onClick={() => void run("checkout", async () => {
                              await client.gitCheckout(tg, false, cwd);
                              setShowBranches(false);
                              setBranchQuery("");
                            })}
                          >
                            <span className="shrink-0 text-[var(--color-ink-faint)]">⌖</span>
                            <span className="min-w-0 flex-1 truncate">{tg}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                );
              })()}
            </div>
          )}

          <GitFileGroup
            title={t("Staged")}
            files={staged}
            empty={t("Nothing staged")}
            actionLabel={t("Unstage")}
            onAction={(p) => void run("unstage", () => client.gitUnstage(p ? [p] : undefined, cwd))}
            busy={!!busy}
          />
          <GitFileGroup
            title={t("Changes")}
            files={unstaged}
            empty={t("No changes")}
            actionLabel={t("Stage")}
            onAction={(p) => void run("stage", () => client.gitStage(p ? [p] : undefined, cwd))}
            busy={!!busy}
            onStageAll={unstaged.length > 0 ? () => void run("stage", () => client.gitStage(undefined, cwd)) : undefined}
          />

          <div className="border-t border-[var(--color-edge-subtle)] p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="cp-eyebrow">{t("Commit message")}</span>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] disabled:opacity-50"
                disabled={busy === "genmsg"}
                onClick={() => void genMessage()}
                title={t("Generate from staged diff")}
              >
                {busy === "genmsg" ? <SpinnerIcon className="h-3 w-3" /> : <GitIcon className="h-3 w-3" />}
                {t("Generate")}
              </button>
            </div>
            <textarea
              className="cp-input min-h-16 w-full text-[12.5px]"
              placeholder={t("Describe your changes…")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                className="cp-btn flex-1 py-1.5 text-[12px]"
                disabled={!message.trim() || staged.length === 0 || !!busy}
                onClick={() => void run("commit", async () => {
                  await client.gitCommit(message.trim(), false, cwd);
                  setMessage("");
                  setNotice(t("Committed."));
                })}
                title={staged.length === 0 ? t("Stage changes before committing") : undefined}
              >
                {busy === "commit" ? `${t("Committing")}…` : t("Commit")}
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button type="button" className="cp-btn-ghost flex-1 py-1.5 text-[12px]" disabled={!!busy} onClick={() => void run("pull", () => client.gitPull({ cwd }))}>
                {busy === "pull" ? `${t("Pulling")}…` : t("Pull")}
              </button>
              <button type="button" className="cp-btn-ghost flex-1 py-1.5 text-[12px]" disabled={!!busy} onClick={() => void run("push", () => client.gitPush({ cwd }))}>
                {busy === "push" ? `${t("Pushing")}…` : t("Push")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function GitFileGroup({
  title,
  files,
  empty,
  actionLabel,
  onAction,
  onStageAll,
  busy,
}: {
  title: string;
  files: GitFile[];
  empty: string;
  actionLabel: string;
  onAction(path?: string): void;
  onStageAll?(): void;
  busy: boolean;
}): React.ReactElement {
  return (
    <div className="border-b border-[var(--color-edge-subtle)] p-2">
      <div className="mb-1 flex items-center">
        <span className="cp-eyebrow">{title}</span>
        <span className="ml-1.5 font-mono text-[10px] text-[var(--color-ink-faint)]">{files.length}</span>
        {onStageAll && (
          <button type="button" className="ml-auto text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50" disabled={busy} onClick={onStageAll}>
            {actionLabel} {t("all")}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-1 py-1 text-[11px] text-[var(--color-ink-faint)]">{empty}</div>
      ) : (
        <ul className="space-y-0.5">
          {files.map((f) => (
            <li key={f.path} className="group flex items-center gap-1.5">
              <span className={`shrink-0 rounded px-1 font-mono text-[10px] ${gitTone(f.status)}`}>{gitLabel(f)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-ink-dim)]" title={f.path}>{f.path}</span>
              <button
                type="button"
                className="shrink-0 text-[10.5px] text-[var(--color-accent)] opacity-0 hover:underline group-hover:opacity-100 disabled:opacity-50"
                disabled={busy}
                onClick={() => onAction(f.path)}
              >
                {actionLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function gitTone(status: string): string {
  const s = status.trim();
  if (s.includes("?")) return "bg-[var(--color-add-dim)] text-[var(--color-add)]";
  if (s.includes("D")) return "bg-[var(--color-remove-dim)] text-[var(--color-remove)]";
  if (s.includes("A")) return "bg-[var(--color-add-dim)] text-[var(--color-add)]";
  return "bg-[var(--color-warn-dim)] text-[var(--color-warn)]";
}

/** Friendly single-letter label for a git status pair ("??" → "N" for new). */
function gitLabel(f: GitFile): string {
  const s = f.status.trim();
  if (s === "??") return "N"; // untracked / new
  const code = (f.index !== " " && f.index !== "?" ? f.index : f.worktree).trim();
  switch (code) {
    case "A": return "A"; // added
    case "M": return "M"; // modified
    case "D": return "D"; // deleted
    case "R": return "R"; // renamed
    case "C": return "C"; // copied
    default: return code || "M";
  }
}
