import { useContext, useState } from "react";

import type { ToolRow } from "../../state/rows.js";
import {
  formatDuration,
  formatTokens,
  toolCategory,
  toolFilePaths,
  toolTarget,
  toolVerb,
} from "../../state/selectors.js";
import { t } from "../../i18n.js";
import { looksLikeWorkspacePath } from "../../state/paths.js";
import { DiffBlock } from "../DiffBlock.js";
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  SpinnerIcon,
  XIcon,
} from "../Icons.js";
import { SubagentContext, OpenPathContext } from "./contexts.js";
import { CATEGORY_ICON, CategoryIcon, SubagentStateIcon } from "./icons.js";
import { ImageStrip } from "./MessageViews.js";

export function StepGroup({ tools, live }: { tools: ToolRow[]; live: boolean }): React.ReactElement {
  const running = tools.some((x) => x.status === "running");
  const failed = tools.filter((x) => x.status === "error").length;
  const taskTools = tools.filter((x) => x.name === "task");
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
 // Live groups stay open so progress is visible; finished ones fold to a
 // one-line summary unless the user opened them — keep open when the group
 // delegated to sub-agents so their transcripts stay one click away.
  const open = userOpen ?? (running || live || tools.length <= 2 || taskTools.length > 0);

  const categories = [...new Set(tools.map((x) => toolCategory(x.name)))].slice(0, 5);
  const startedAt = tools[0]?.startedAt;
  const finishedAt = tools[tools.length - 1]?.finishedAt;

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {running ? (
          <SpinnerIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        ) : failed > 0 ? (
          <AlertIcon className="h-3.5 w-3.5 text-[var(--color-warn)]" />
        ) : (
          <CheckIcon className="h-3.5 w-3.5 text-[var(--color-add)]" />
        )}
        <span className="font-medium text-[var(--color-ink)]">
          {running ? t("Running") : t("Ran")} {tools.length} {t(tools.length === 1 ? "step" : "steps")}
        </span>
        <span className="flex items-center gap-1 text-[var(--color-ink-faint)]">
          {categories.map((c) => {
            const Icon = CATEGORY_ICON[c];
            return <Icon key={c} className="h-3 w-3" />;
          })}
        </span>
        {failed > 0 && (
          <span className="rounded-full bg-[var(--color-warn-dim)] px-1.5 text-[10px] text-[var(--color-warn)]">
            {failed} {t("failed")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
          {!running && startedAt && finishedAt && formatDuration(finishedAt - startedAt)}
          <ChevronIcon open={open} className="h-3 w-3" />
        </span>
      </button>
      {open && (
        <ul className="border-t border-[var(--color-edge-subtle)] py-1">
          {tools.map((tool) => (
            <StepItem key={tool.id} tool={tool} showSubagents={false} />
          ))}
        </ul>
      )}
      {/* Always reachable after the main turn finishes — even if the step list is folded. */}
      {taskTools.length > 0 && (
        <div className={`space-y-1 px-2 pb-2 ${open ? "pt-0" : "border-t border-[var(--color-edge-subtle)] pt-1.5"}`}>
          {taskTools.map((tool) => (
            <SubagentChips key={tool.id} toolCallId={tool.id} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Stable, human-distinguishable tag for one sub-agent. The per-`task` `index`
 * restarts at 0 each call (bare `#1` repeats), so prefer the session-global
 * `runSeq` (monotonic `#N`) + a short slice of the sub-agent id
 * (`#3·a9f2`); fall back to the parent tool-call id prefix for old runs.
 */
export function subagentTag(toolCallId: string, run: { index: number; runSeq?: number; sessionId?: string }): string {
  const seq = run.runSeq ?? run.index + 1;
  const id = run.sessionId
    ? run.sessionId.replace(/[^a-z0-9]/gi, "").slice(-4)
    : toolCallId.replace(/[^a-z0-9]/gi, "").slice(-4) || toolCallId.slice(0, 4);
  return `#${seq}·${id}`;
}

/** One clickable chip per sub-agent of a `task` call (available after completion too). */
function SubagentChips({ toolCallId }: { toolCallId: string }): React.ReactElement | null {
  const nav = useContext(SubagentContext);
  const runs = nav?.runs[toolCallId];
  if (!nav || !runs?.length) return null;
  return (
    <div className="flex flex-col gap-1 px-1">
      {runs.map((r) => {
        const steps = r.view.rows.filter((x) => x.kind === "tool").length;
        const last = [...r.view.rows].reverse().find((x) => x.kind === "tool");
        const doing =
          r.state === "running" && last?.kind === "tool"
            ? toolTarget(last.tool.input) || toolVerb(last.tool.name, last.tool.input)
            : "";
        const statusLabel =
          r.state === "running" ? t("Running") : r.state === "failed" ? t("failed") : t("done");
        const tok =
          r.view.usage.input > 0 || r.view.usage.output > 0
            ? `${formatTokens(r.view.usage.input)} / ${formatTokens(r.view.usage.output)}`
            : "";
        return (
          <button
            key={`${toolCallId}:${r.index}`}
            type="button"
            onClick={() => nav.open(toolCallId, r.index)}
            title={t("View subtask")}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2 py-1.5 text-left text-[11.5px] transition-colors hover:border-[var(--color-accent)]"
          >
            <SubagentStateIcon state={r.state} />
            <span className="shrink-0 font-mono text-[var(--color-ink-faint)]">{subagentTag(toolCallId, r)}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{r.objective}</span>
            {doing && (
              <span className="min-w-0 max-w-[35%] truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">
                {doing}
              </span>
            )}
            {tok && (
              <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]" title={t("tokens")}>
                {tok}
              </span>
            )}
            <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">{statusLabel}</span>
            <span className="shrink-0 text-[10.5px] text-[var(--color-accent)]">
              {steps} {t(steps === 1 ? "step" : "steps")} · {t("View subtask")} ›
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PathChip({ path }: { path: string }): React.ReactElement {
  const onOpen = useContext(OpenPathContext);
  if (!onOpen || !looksLikeWorkspacePath(path)) {
    return (
      <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink)]" title={path}>
        {path}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`${t("Preview")} ${path}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(path);
      }}
      className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-accent)] underline-offset-2 hover:underline"
    >
      {path}
    </button>
  );
}

function StepItem({
  tool,
  showSubagents = true,
}: {
  tool: ToolRow;
  /** When false, parent (StepGroup) already renders SubagentChips. */
  showSubagents?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const onOpenPath = useContext(OpenPathContext);
  const paths = toolFilePaths(tool.input);
  const target = toolTarget(tool.input);
  const verb = toolVerb(tool.name, tool.input);
  const duration =
    tool.startedAt && tool.finishedAt ? formatDuration(tool.finishedAt - tool.startedAt) : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
            tool.status === "error"
              ? "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"
              : tool.status === "running"
                ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                : "bg-[var(--color-surface-sunken)] text-[var(--color-ink-dim)]"
          }`}
        >
          {tool.status === "running" ? (
            <SpinnerIcon className="h-3 w-3" />
          ) : (
            <CategoryIcon name={tool.name} className="h-3 w-3" />
          )}
        </span>
        <span className="shrink-0 text-[var(--color-ink-dim)]">{t(verb)}</span>
        {paths.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {paths.map((p, i) => (
              <span key={`${p}-${i}`} className="flex min-w-0 items-center gap-1">
                {i > 0 && <span className="text-[var(--color-ink-faint)]">·</span>}
                <PathChip path={p} />
              </span>
            ))}
          </span>
        ) : target ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink)]">{target}</span>
        ) : null}
        {tool.change && (
          <span className="shrink-0 font-mono text-[10.5px]">
            {tool.change.added > 0 && <span className="text-[var(--color-add)]">+{tool.change.added}</span>}
            {tool.change.removed > 0 && (
              <span className="ml-1 text-[var(--color-remove)]">−{tool.change.removed}</span>
            )}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10.5px] text-[var(--color-ink-faint)]">
          {tool.status === "error" && <XIcon className="h-3 w-3 text-[var(--color-remove)]" />}
          {duration}
          <ChevronIcon open={open} className="h-3 w-3" />
        </span>
      </button>
      {showSubagents && tool.name === "task" && <SubagentChips toolCallId={tool.id} />}
      {open && (
        <div className="space-y-2 px-3 pt-1 pb-2.5 pl-10">
          {tool.change ? (
            <DiffBlock change={tool.change} onOpenPath={onOpenPath} />
          ) : (
            <Labelled label={t("input")}>
              <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--color-surface-sunken)] p-2 text-[11px] leading-5 whitespace-pre-wrap text-[var(--color-ink-dim)]">
                {formatInput(tool.input)}
              </pre>
            </Labelled>
          )}
          {tool.result !== undefined && (
            <Labelled label={tool.status === "error" ? t("error") : t("result")}>
              <pre
                className={`max-h-72 overflow-auto rounded-lg p-2 text-[11px] leading-5 whitespace-pre-wrap ${
                  tool.status === "error"
                    ? "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"
                    : "bg-[var(--color-surface-sunken)] text-[var(--color-ink-dim)]"
                }`}
              >
                {tool.result || "(no output)"}
              </pre>
            </Labelled>
          )}
          {tool.images && tool.images.length > 0 && <ImageStrip images={tool.images} />}
          {tool.artifactRef && (
            <div className="text-[11px] text-[var(--color-ink-faint)]">
              {t("Full output saved as artifact")} <code className="cp-chip">{tool.artifactRef}</code>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">{label}</div>
      {children}
    </div>
  );
}

export function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    // apply_patch: prefer file list (+ optional patch body) over opaque JSON.
    const filesFromField =
      Array.isArray(o.files) && o.files.every((f) => typeof f === "string") ? (o.files as string[]) : null;
    const filesFromPatch =
      typeof o.patch === "string"
        ? toolFilePaths(o)
        : null;
    const files = filesFromField ?? filesFromPatch;
    if (files && (files.length > 0 || typeof o.patch === "string")) {
      const head = files.length ? `Files:\n${files.map((f) => `  ${f}`).join("\n")}` : "Files: (none)";
      if (typeof o.patch === "string" && o.patch.length > 0) {
        const max = 4000;
        const body = o.patch.length > max ? `${o.patch.slice(0, max)}\n…` : o.patch;
        return `${head}\n\n${body}`;
      }
      return head;
    }
    // Background-job tools: prefer the resolved command over bare job_id JSON.
    if (typeof o.command === "string" && typeof o.job_id === "string") {
      const parts = [o.command];
      const meta = [`job ${o.job_id}`];
      if (typeof o.status === "string") meta.push(o.status);
      parts.push(`(${meta.join(", ")})`);
      if (typeof o.input === "string" && o.input.length > 0) {
        parts.push(`stdin:\n${o.input}`);
      }
      return parts.join("\n\n");
    }
    if (typeof o.command === "string") return o.command;
    if (typeof o.path === "string") return o.path;
  }
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}