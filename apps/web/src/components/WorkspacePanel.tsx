import { useEffect, useMemo, useRef, useState } from "react";
import { acceptSave, changedExternally, canSave, type EditorFile } from "../state/workspaceEditor.js";
import { GitDiffController, type GitDiffState } from "../state/gitDiff.js";
import type { CodepilotClient } from "../protocol/client.js";
import type { Row } from "../state/rows.js";
import { t } from "../i18n.js";
import {
  FileIcon,
  FolderIcon,
  GitIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "./Icons.js";
import { InteractiveTerminal } from "./InteractiveTerminal.js";

type Entry = { name: string; path: string; kind: "file" | "directory"; size?: number };

export function WorkspacePanel({ client, cwd, connected, rows = [] }: { client: CodepilotClient; cwd: string; connected: boolean; rows?: Row[] }): React.ReactElement {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<EditorFile | null>(null);
  const readRevision = useRef(0);
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ path: string; line: number; text: string }>>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const searchRevision = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [git, setGit] = useState<{ branch: string; files: Array<{ path: string; status: string }> } | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffState | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
  const diffController = useMemo(() => new GitDiffController(
    (file, staged) => client.gitDiff(file, staged), setGitDiff,
  ), [client]);
  useEffect(() => {
    diffController.close();
    return () => diffController.invalidate();
  }, [diffController, cwd, connected]);
  const [externalChanged, setExternalChanged] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalTab, setTerminalTab] = useState<"pty" | "bash">("pty");
  const bashRuns = useMemo(() => {
    return rows
      .filter((r): r is Extract<Row, { kind: "tool" }> => r.kind === "tool" && r.tool.name === "bash")
      .map((r) => {
        const input = r.tool.input as { command?: unknown } | null;
        const command =
          input && typeof input.command === "string" ? input.command : undefined;
        return {
          id: r.tool.id,
          command,
          result: r.tool.result,
          status: r.tool.status,
        };
      });
  }, [rows]);
  const openFile = async (file: string) => {
    if (saving || (dirty && !window.confirm("Discard unsaved changes and reload?"))) return;
    const revision = ++readRevision.current;
    try {
      const result = await client.readWorkspace(file);
      if (revision !== readRevision.current) return;
      setSelected({ ...result, original: result.content, originalHash: result.hash });
      setDirty(false); setExternalChanged(false); setShowDiff(false); setError(null);
    } catch (err) {
      if (revision === readRevision.current) setError(String(err));
    }
  };
  const load = async (next = path) => {
    if (saving || (dirty && !window.confirm("Discard unsaved changes?"))) return;
    const revision = ++readRevision.current;
    try {
      const result = await client.listWorkspace(next);
      if (revision !== readRevision.current) return;
      setError(null); setEntries(result.entries); setPath(next); setSelected(null); setDirty(false);
    } catch (err) { if (revision === readRevision.current) setError(String(err)); }
  };
  useEffect(() => () => { readRevision.current++; searchRevision.current++; setMatches([]); setSearchTruncated(false); }, [cwd, connected]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { if (connected) void load(); }, [connected, cwd]);
 // Server-pushed disk changes: refresh the visible listing and re-check the
 // open file immediately (the 3s poll below remains as a fallback when the
 // watcher itself errors — `error` in the notification).
  useEffect(() => {
    client.setWorkspaceChangedHandler((params) => {
      if (params.error) { setWatchError(params.error); return; }
      setWatchError(null);
      void client.listWorkspace(path).then(r => setEntries(r.entries)).catch(() => {});
      if (selected) {
        void client.workspaceStat(selected.path).then(s => {
          setExternalChanged(changedExternally(selected, s));
        }).catch(() => {});
      }
    });
    return () => client.setWorkspaceChangedHandler(null);
  }, [client, path, selected?.path, selected?.originalHash, selected]);
  useEffect(() => {
    if (!connected) return;
    void client.watchWorkspace(".").catch(() => setWatchError("watch unavailable — polling"));
  }, [client, connected, cwd]);
  useEffect(() => { setDirty(false); setExternalChanged(false); }, [selected?.path]);
  useEffect(() => {
    if (!selected || !connected || saving) return;
    let active = true;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void client.workspaceStat(selected.path).then(s => {
        if (active) setExternalChanged(changedExternally(selected, s));
      }).catch(() => {}).finally(() => { pending = false; });
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, connected, saving, selected?.path, selected?.originalHash]);
  const parent = path === "." ? "." : path.split("/").slice(0, -1).join("/") || ".";
  return (
    <aside className="flex w-[min(42rem,52vw)] min-w-[22rem] shrink-0 flex-col border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
      <PanelHeader>
        <span className="text-[11px] font-semibold tracking-wide text-[var(--color-ink-dim)]">{t("Workspace")}</span>
        <div className="ml-auto flex items-center gap-1">
          <HeaderButton
            onClick={() => setTerminalOpen((v) => !v)}
            active={terminalOpen}
            title={t("Open terminal")}
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </HeaderButton>
          <HeaderButton onClick={() => void load()} title="Refresh listing">
            <RefreshIcon className="h-3.5 w-3.5" />
          </HeaderButton>
        </div>
      </PanelHeader>

      <div className="flex items-center gap-1 border-b border-[var(--color-edge-subtle)] px-3 py-1.5 font-mono text-[10px] text-[var(--color-ink-faint)]">
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{path}</span>
      </div>

      <button type="button" onClick={() => void client.gitStatus().then(setGit).catch(err => setError(String(err)))}
        className="group flex w-full items-center gap-1.5 border-b border-[var(--color-edge-subtle)] px-3 py-1.5 text-left text-[10px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-raised)]">
        <GitIcon className="h-3 w-3 shrink-0 text-[var(--color-ink-faint)] group-hover:text-[var(--color-accent)]" />
        <span className="font-mono">{git?.branch ?? "load status"}</span>
        {git && git.files.length > 0 && (
          <span className="ml-auto rounded-full bg-[var(--color-accent-dim)] px-1.5 font-mono text-[9px] text-[var(--color-accent)]">{git.files.length}</span>
        )}
      </button>
      {git && (
        <div className="max-h-20 shrink-0 overflow-auto border-b border-[var(--color-edge-subtle)]">
          {git.files.length ? git.files.map(f => (
            <button type="button" key={f.path} onClick={() => { void diffController.load(f.path, diffStaged); }}
              className="group flex w-full items-center gap-1.5 px-3 py-1 text-left text-[10px] transition-colors hover:bg-[var(--color-surface-raised)]">
              <span className={`shrink-0 rounded px-1 font-mono ${gitStatusTone(f.status)}`}>{f.status}</span>
              <span className="truncate font-mono text-[var(--color-ink-dim)]">{f.path}</span>
            </button>
          )) : <div className="px-3 py-1 text-[10px] text-[var(--color-ink-faint)]">Clean</div>}
        </div>
      )}

      <form className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-subtle)] p-2" onSubmit={e => {
        e.preventDefault();
        const revision = ++searchRevision.current;
        void client.searchWorkspace(query, path).then(r => {
          if (revision === searchRevision.current) { setMatches(r.matches); setSearchTruncated(r.truncated); setError(null); }
        }).catch(err => { if (revision === searchRevision.current) setError(String(err)); });
      }}>
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-faint)]" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search workspace…"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-edge-subtle)] bg-transparent px-2 py-1 text-xs text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]" />
        <button type="submit" className="rounded-md border border-[var(--color-edge-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]">Go</button>
      </form>

      {error && <div className="mx-2 mt-2 shrink-0 rounded-md border border-[var(--color-remove-dim)] bg-[var(--color-remove-dim)] px-2 py-1 text-[10px] text-[var(--color-remove)]">{error}</div>}
      {watchError && <div role="status" className="shrink-0 px-3 py-1 text-[10px] text-[var(--color-ink-faint)]">Live watch unavailable ({watchError}); polling.</div>}
      {searchTruncated && <div role="status" className="shrink-0 px-3 py-1 text-[10px] text-[var(--color-ink-faint)]">Search results truncated.</div>}

      {matches.length > 0 && (
        <div className="max-h-28 shrink-0 overflow-auto border-b border-[var(--color-edge-subtle)]">
          {matches.map((m, i) => (
            <button key={`${m.path}:${m.line}:${i}`} type="button" onClick={() => void openFile(m.path)}
              className="block w-full truncate px-3 py-1 text-left transition-colors hover:bg-[var(--color-surface-raised)]">
              <span className="font-mono text-[10px] text-[var(--color-accent)]">{m.path}:{m.line}</span>{" "}
              <span className="text-[10px] text-[var(--color-ink-dim)]">{m.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* File tree + editor side by side */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[11.5rem] shrink-0 flex-col overflow-auto border-r border-[var(--color-edge-subtle)] py-1">
          {path !== "." && (
            <button type="button" onClick={() => void load(parent)}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-raised)]">
              <FolderIcon className="h-3.5 w-3.5" /> ..
            </button>
          )}
          {entries.map(e => (
            <button key={e.path} type="button" onClick={() => e.kind === "directory" ? void load(e.path) : void openFile(e.path)}
              className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)] ${
                selected?.path === e.path ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)]"
              }`}>
              {e.kind === "directory"
                ? <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]/70" />
                : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-faint)]" />}
              <span className="truncate">{e.name}</span>
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface-sunken)]">
          {gitDiff !== null && (
            <section aria-label="Git diff" className="max-h-[40%] shrink-0 overflow-auto border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
              <div className="sticky top-0 flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-3 py-1 text-[10px] text-[var(--color-ink-dim)]">
                <FileIcon className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{gitDiff.path}</span>
                <span className="rounded bg-[var(--color-surface-hover)] px-1 text-[9px]">{gitDiff.staged ? "staged" : "unstaged"}</span>
                <div className="ml-auto flex shrink-0 gap-2">
                  <button type="button" aria-pressed={gitDiff.staged} onClick={() => {
                    const staged = !gitDiff.staged;
                    setDiffStaged(staged);
                    void diffController.load(gitDiff.path, staged);
                  }} className="text-[var(--color-accent)] hover:underline">Toggle staged</button>
                  <button type="button" aria-label="Close Git diff" onClick={() => diffController.close()} className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"><XIcon className="h-3 w-3" /></button>
                </div>
              </div>
              {gitDiff.loading ? <p role="status" className="px-3 py-2 text-[10px] text-[var(--color-ink-faint)]">Loading diff…</p> :
                gitDiff.error ? <p role="alert" className="px-3 py-2 text-[10px] text-[var(--color-remove)]">{gitDiff.error}</p> : <>
                  {gitDiff.truncated && <p role="status" className="px-3 py-1 text-[10px] text-[var(--color-ink-faint)]">Diff truncated by server.</p>}
                  <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-4 text-[var(--color-ink-dim)]">{gitDiff.diff || `No ${gitDiff.staged ? "staged" : "unstaged"} diff (untracked files have no Git patch).`}</pre>
                </>}
            </section>
          )}

          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 font-mono text-[10px]">
                <FileIcon className="h-3 w-3 shrink-0 text-[var(--color-ink-faint)]" />
                <span className="truncate text-[var(--color-ink)]">{selected.path}</span>
                {selected.truncated && <span className="shrink-0 text-[var(--color-warn)]">(truncated — read-only)</span>}
                {dirty && <span className="shrink-0 rounded bg-[var(--color-accent-dim)] px-1 text-[var(--color-accent)]">modified</span>}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {externalChanged && <span className="text-[var(--color-remove)]">changed externally</span>}
                  <button type="button" disabled={saving} onClick={() => void openFile(selected.path)}
                    className="text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] disabled:opacity-40">Reload</button>
                  {dirty && <>
                    <button type="button" onClick={() => setShowDiff(v => !v)}
                      className="text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">{showDiff ? "Hide diff" : "Diff"}</button>
                    <button type="button" disabled={!canSave(selected, saving, externalChanged)}
                      onClick={() => {
                        if (!window.confirm("Save changes to this file?")) return;
                        readRevision.current++; setSaving(true);
                        void client.writeWorkspace(selected.path, selected.content, selected.size, selected.originalHash)
                          .then(r => { setSelected(acceptSave(selected, r)); setDirty(false); setExternalChanged(false); })
                          .catch(err => setError(String(err)))
                          .finally(() => setSaving(false));
                      }}
                      title="Save changes"
                      className="flex items-center gap-1 text-[var(--color-accent)] hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline">
                      <SaveIcon className="h-3 w-3" />
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </>}
                  <button type="button" aria-label="Close file" onClick={() => {
                    if (dirty && !window.confirm("Discard unsaved changes?")) return;
                    setSelected(null); setDirty(false); setShowDiff(false);
                  }} className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
                    <XIcon className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
                <pre className="sticky left-0 select-none border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface)] px-2 py-1 text-right text-[var(--color-ink-faint)]">
                  {selected.content.split("\n").map((_, i) => `${i + 1}\n`)}
                </pre>
                {showDiff && (
                  <pre className="shrink-0 border-r border-[var(--color-edge-subtle)] bg-[var(--color-accent-dim)] p-2 text-[11px] text-[var(--color-ink-dim)]">
                    {selected.original === selected.content ? "No changes" : `--- original\n+++ edited\n${selected.content}`}
                  </pre>
                )}
                <textarea aria-label="File editor" readOnly={selected.truncated || saving} value={selected.content}
                  onChange={e => { setSelected({ ...selected, content: e.target.value }); setDirty(e.target.value !== selected.original); }}
                  spellCheck={false}
                  className="min-w-0 flex-1 resize-none whitespace-pre-wrap bg-transparent px-3 py-1 outline-none" />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
              <FileIcon className="h-8 w-8 text-[var(--color-ink-faint)]" />
              <p className="text-[12px] text-[var(--color-ink-dim)]">{t("Select a file to preview and edit")}</p>
              <p className="text-[11px] text-[var(--color-ink-faint)]">{t("Files the agent creates or edits show up here.")}</p>
            </div>
          )}
        </div>
      </div>

      {terminalOpen && (
        <div className="flex h-[min(38vh,22rem)] shrink-0 flex-col border-t border-[var(--color-edge-subtle)]">
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-2 py-1">
            <button
              type="button"
              className={
                terminalTab === "pty"
                  ? "rounded px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
                  : "rounded px-2 py-0.5 text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
              }
              onClick={() => setTerminalTab("pty")}
            >
              {t("Terminal")}
            </button>
            <button
              type="button"
              className={
                terminalTab === "bash"
                  ? "rounded px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
                  : "rounded px-2 py-0.5 text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
              }
              onClick={() => setTerminalTab("bash")}
            >
              {t("Agent bash")}
            </button>
            <button
              type="button"
              className="ml-auto rounded p-1 text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
              title={t("Close")}
              onClick={() => setTerminalOpen(false)}
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
          {terminalTab === "pty" ? (
            <div className="min-h-0 flex-1">
              <InteractiveTerminal client={client} cwd={cwd} connected={connected} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface-sunken)] p-3 font-mono text-[11px]">
              <div className="mb-1 flex items-center gap-1.5 text-[var(--color-ink-faint)]">
                <TerminalIcon className="h-3 w-3" />
                <span>{t("Bash tool output")}</span>
              </div>
              {bashRuns.length === 0 ? (
                <p className="text-[11px] leading-4 text-[var(--color-ink-faint)]">
                  {t(
                    "This panel mirrors commands the agent runs with the bash tool. It is not an interactive terminal — ask the agent to run a command, then output appears here.",
                  )}
                </p>
              ) : (
                <div className="space-y-2">
                  {bashRuns.map((run) => (
                    <div key={run.id} className="rounded border border-[var(--color-edge-subtle)]/60 p-1.5">
                      {run.command && (
                        <div className="whitespace-pre-wrap text-[var(--color-accent)]">
                          $ {run.command}
                        </div>
                      )}
                      {run.status === "running" && (
                        <div className="text-[var(--color-ink-faint)]">{t("… running")}</div>
                      )}
                      {run.result ? (
                        <div
                          className={`mt-0.5 whitespace-pre-wrap ${
                            run.status === "error"
                              ? "text-[var(--color-remove)]"
                              : "text-[var(--color-add)]"
                          }`}
                        >
                          {run.result}
                        </div>
                      ) : run.status !== "running" ? (
                        <div className="text-[var(--color-ink-faint)]">{t("(no output)")}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function PanelHeader({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex h-11 shrink-0 items-center border-b border-[var(--color-edge-subtle)] px-3">{children}</div>;
}

function HeaderButton({ onClick, active, title, children }: {
  onClick: () => void; active?: boolean; title: string; children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
      className={`rounded-md border p-1 transition-colors ${
        active
          ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
          : "border-transparent text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
      }`}>
      {children}
    </button>
  );
}

/** Color class for a two-letter git status code (M / A / D / ??…). */
function gitStatusTone(status: string): string {
  const c = status.trim()[0] ?? "";
  if (c === "M") return "bg-[var(--color-warn-dim)] text-[var(--color-warn)]";
  if (c === "A" || c === "?") return "bg-[var(--color-add-dim)] text-[var(--color-add)]";
  if (c === "D") return "bg-[var(--color-remove-dim)] text-[var(--color-remove)]";
  return "bg-[var(--color-surface-hover)] text-[var(--color-ink-dim)]";
}
