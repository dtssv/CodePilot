import { useEffect, useMemo, useRef, useState } from "react";
import { acceptSave, changedExternally, canSave, type EditorFile } from "../state/workspaceEditor.js";
import { GitDiffController, type GitDiffState } from "../state/gitDiff.js";
import type { CodepilotClient } from "../protocol/client.js";
import type { Row } from "../state/rows.js";

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
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalLines = rows.filter((r): r is Extract<Row, { kind: "tool" }> => r.kind === "tool" && r.tool.name === "bash").flatMap(r => [r.tool.result ?? "", r.tool.status === "running" ? "… running" : ""] ).filter(Boolean);
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
  useEffect(() => () => { readRevision.current++; }, [cwd, connected]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { if (connected) void load(); }, [connected, cwd]);
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
  return <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--color-edge)] bg-[var(--color-surface-sunken)] text-xs">
    <div className="flex items-center justify-between border-b border-[var(--color-edge)] px-3 py-2 font-medium"><span>Workspace</span><button type="button" onClick={() => setTerminalOpen(v => !v)} className="rounded border px-1.5 py-0.5">Terminal</button><button type="button" onClick={() => void load()} className="rounded border px-1.5 py-0.5">Refresh</button></div>
    <div className="border-b border-[var(--color-edge)] px-3 py-1 font-mono text-[10px]">{path}</div><button type="button" onClick={() => void client.gitStatus().then(setGit).catch(err => setError(String(err)))} className="border-b border-[var(--color-edge)] px-3 py-1 text-left text-[10px] hover:bg-[var(--color-surface-raised)]">Git: {git?.branch ?? "load status"}</button>{git && <div className="max-h-24 overflow-auto border-b border-[var(--color-edge)]">{git.files.length ? git.files.map(f => <button type="button" key={f.path} onClick={() => { void diffController.load(f.path, diffStaged); }} className="block w-full truncate px-3 py-1 text-left font-mono text-[10px] hover:bg-[var(--color-surface-raised)]">{f.status} {f.path}</button>) : <div className="px-3 py-1 text-[10px]">Clean</div>}</div>}
    <form className="flex gap-1 border-b border-[var(--color-edge)] p-2" onSubmit={e => { e.preventDefault(); void client.searchWorkspace(query).then(r => setMatches(r.matches)).catch(err => setError(String(err))); }}><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search workspace" className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1" /><button type="submit" className="rounded border px-2">Go</button></form>
    {error && <div className="p-2 text-[var(--color-remove)]">{error}</div>}
    {matches.length > 0 && <div className="max-h-36 overflow-auto border-b border-[var(--color-edge)]">{matches.map((m, i) => <button key={`${m.path}:${m.line}:${i}`} type="button" onClick={() => void openFile(m.path)} className="block w-full truncate px-2 py-1 text-left hover:bg-[var(--color-surface-raised)]"><span className="font-mono">{m.path}:{m.line}</span> {m.text}</button>)}</div>}
    <div className="min-h-0 flex-1 overflow-auto">{path !== "." && <button type="button" onClick={() => void load(parent)} className="block w-full px-3 py-1 text-left hover:bg-[var(--color-surface-raised)]">↩ ..</button>}{entries.map(e => <button key={e.path} type="button" onClick={() => e.kind === "directory" ? void load(e.path) : void openFile(e.path)} className="block w-full truncate px-3 py-1 text-left hover:bg-[var(--color-surface-raised)]">{e.kind === "directory" ? "▸ " : "· "}{e.name}</button>)}</div>
    {gitDiff !== null && (
      <section aria-label="Git diff" className="max-h-48 overflow-auto border-b border-[var(--color-edge)] bg-black/20">
        <div className="flex flex-wrap justify-between px-3 py-1 text-[10px]">
          <span>{gitDiff.path} — {gitDiff.staged ? "staged" : "unstaged"}</span>
          <button type="button" aria-pressed={gitDiff.staged} onClick={() => {
            const staged = !gitDiff.staged;
            setDiffStaged(staged);
            void diffController.load(gitDiff.path, staged);
          }}>Toggle staged</button>
          <button type="button" aria-label="Close Git diff" onClick={() => diffController.close()}>×</button>
        </div>
        {gitDiff.loading ? <p role="status" className="px-3">Loading diff…</p> :
          gitDiff.error ? <p role="alert" className="px-3 text-[var(--color-remove)]">{gitDiff.error}</p> : <>
            {gitDiff.truncated && <p role="status" className="px-3">Diff truncated by server.</p>}
            <pre className="whitespace-pre-wrap px-3 pb-2 font-mono text-[10px]">{gitDiff.diff || `No ${gitDiff.staged ? "staged" : "unstaged"} diff (untracked files have no Git patch).`}</pre>
          </>}
      </section>
    )}
    {terminalOpen && <div className="max-h-40 overflow-auto border-t border-[var(--color-edge)] bg-black p-2 font-mono text-[10px] text-green-300"><div className="mb-1 text-gray-400">Terminal output (bash tool)</div>{terminalLines.length ? terminalLines.map((line, i) => <div key={i} className="whitespace-pre-wrap">{line}</div>) : <span className="text-gray-500">No terminal output yet.</span>}</div>}
    {selected && <div className="max-h-64 overflow-auto border-t border-[var(--color-edge)]"><div className="sticky top-0 flex items-center gap-2 bg-[var(--color-surface-sunken)] px-3 py-1 font-mono text-[10px]"><span>{selected.path}{selected.truncated ? " (truncated — read-only)" : ""}{dirty ? " *" : ""}</span><button type="button" disabled={saving} onClick={() => void openFile(selected.path)}>Reload</button>{externalChanged && <span className="text-[var(--color-remove)]">changed externally — reload before saving</span>}{dirty && <><span className="text-[var(--color-accent)]">modified</span><button type="button" onClick={() => setShowDiff(v => !v)} className="rounded border px-1.5 py-0.5">{showDiff ? "Hide diff" : "Diff"}</button></>}{dirty && <button type="button" disabled={!canSave(selected, saving, externalChanged)} onClick={() => { if (!window.confirm("Save changes to this file?")) return; readRevision.current++; setSaving(true); void client.writeWorkspace(selected.path, selected.content, selected.size, selected.originalHash).then(r => { setSelected(acceptSave(selected, r)); setDirty(false); setExternalChanged(false); }).catch(err => setError(String(err))).finally(() => setSaving(false)); }} className="rounded border px-1.5 py-0.5">{saving ? "Saving…" : "Save"}</button>}</div><div className="flex pb-2 font-mono text-[10px] leading-4"><pre className="select-none border-r border-[var(--color-edge)] px-2 text-right text-[var(--color-ink-dim)]">{selected.content.split("\n").map((_, i) => `${i + 1}\n`)}</pre>{showDiff && <pre className="border-b border-[var(--color-edge)] bg-black/20 p-2 text-[10px]">{selected.original === selected.content ? "No changes" : `--- original\n+++ edited\n${selected.content}`}</pre>}<textarea aria-label="File editor" readOnly={selected.truncated || saving} value={selected.content} onChange={e => { setSelected({ ...selected, content: e.target.value }); setDirty(e.target.value !== selected.original); }} className="min-w-0 flex-1 resize-none whitespace-pre-wrap bg-transparent px-2 outline-none" /></div></div>}
  </aside>;
}
