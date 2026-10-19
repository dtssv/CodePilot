import { useEffect, useState } from "react";

import type { CodepilotClient } from "../protocol/client.js";
import type { AppState } from "../state/reducer.js";
import {
  currentActivity,
  formatTokens,
  planProgress,
  toolCategory,
  CATEGORY_VERB,
  toolTarget,
  touchedFiles,
  type TouchedFile,
} from "../state/selectors.js";
import { t } from "../i18n.js";
import { Composer, type ComposerProps } from "./Chrome.js";
import {
  BookIcon,
  ChartIcon,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  LogoMark,
  PencilIcon,
  RocketIcon,
  SpinnerIcon,
  WrenchIcon,
  XIcon,
} from "./Icons.js";
import { Markdown } from "./Markdown.js";
import { PlanChecklist, ProgressBar } from "./Transcript.js";

interface Template {
  title: string;
  prompt: string;
  icon: (p: { className?: string }) => React.ReactElement;
  tint: string;
}

const TEMPLATES: Template[] = [
  {
    title: "Organize a folder",
    prompt: "Sort the files in this folder into sensible subfolders and give me a summary of what moved.",
    icon: FolderIcon,
    tint: "from-[#8b7cff]/25 to-[#8b7cff]/5 text-[#8b7cff]",
  },
  {
    title: "Write a weekly report",
    prompt: "Read the git log of the last 7 days and write a concise weekly report grouped by theme.",
    icon: PencilIcon,
    tint: "from-[#3fc6ff]/25 to-[#3fc6ff]/5 text-[#29a8db]",
  },
  {
    title: "Analyze data",
    prompt: "Find the CSV/Excel files here, analyze them and summarize the key findings with numbers.",
    icon: ChartIcon,
    tint: "from-[#3fb97f]/25 to-[#3fb97f]/5 text-[#2f9e6a]",
  },
  {
    title: "Fix failing tests",
    prompt: "Run the test suite, find the failing tests and fix them. Explain each fix.",
    icon: WrenchIcon,
    tint: "from-[#e8b04a]/25 to-[#e8b04a]/5 text-[#c48a1f]",
  },
  {
    title: "Write documentation",
    prompt: "Write a README for this project: what it does, how to run it, and the main modules.",
    icon: BookIcon,
    tint: "from-[#f0616d]/20 to-[#f0616d]/5 text-[#d94a57]",
  },
  {
    title: "Research a topic",
    prompt: "Research the topic I describe next on the web and write a sourced summary.",
    icon: GlobeIcon,
    tint: "from-[#5b8dff]/25 to-[#5b8dff]/5 text-[#4a7ae8]",
  },
];

/** Landing screen of the agent app: one big prompt and task templates. */
export function AgentHome({
  composer,
  cwd,
  onPickTemplate,
}: {
  composer: ComposerProps;
  cwd: string;
  onPickTemplate(prompt: string): void;
}): React.ReactElement {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-10">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-70 [background:radial-gradient(50%_60%_at_50%_0%,var(--color-accent-dim),transparent)]" />
      <div className="relative w-full max-w-2xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark size={52} className="mb-4 drop-shadow-[0_8px_24px_rgba(109,91,246,0.35)]" />
          <h1 className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
            {t("What should we get done today?")}
          </h1>
          <p className="mt-2 max-w-md text-[13px] leading-5 text-[var(--color-ink-dim)]">
            {t("CodePilot plans the work, carries it out step by step and reports back.")}
          </p>
        </div>
        <Composer {...composer} size="lg" autoFocus />
        {cwd && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--color-ink-faint)]">
            <FolderIcon className="h-3 w-3" />
            <span className="truncate font-mono">{cwd}</span>
          </div>
        )}
        <div className="mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.title}
              type="button"
              onClick={() => onPickTemplate(t(tpl.prompt))}
              className="group flex items-start gap-3 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface)] p-3 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--color-edge)] hover:shadow-md"
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${tpl.tint}`}>
                <tpl.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-[var(--color-ink)]">{t(tpl.title)}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                  {t(tpl.prompt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Right-hand panel of a running task: progress, activity, deliverables. */
export function TaskPanel({
  state,
  onOpenFile,
}: {
  state: AppState;
  onOpenFile(path: string): void;
}): React.ReactElement {
  const progress = planProgress(state.plan);
  const files = touchedFiles(state.rows);
  const activity = currentActivity(state.rows);
  const busy = state.status !== "idle";

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)] p-3">
      <Section title={t("Progress")} right={progress.total > 0 ? `${progress.done}/${progress.total}` : undefined}>
        {progress.total === 0 ? (
          <div className="text-[12px] text-[var(--color-ink-faint)]">{busy ? `${t("Thinking")}…` : t("No plan yet")}</div>
        ) : (
          <>
            <div className="mb-3">
              <ProgressBar done={progress.done} total={progress.total} />
            </div>
            <PlanChecklist steps={state.plan} dense />
          </>
        )}
      </Section>

      <Section title={t("Activity")}>
        {activity ? (
          <div className="flex items-center gap-2 text-[12px]">
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span className="shrink-0 text-[var(--color-ink-dim)]">{t(CATEGORY_VERB[toolCategory(activity.name)])}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink)]">
              {toolTarget(activity.input) || activity.name}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-ink-faint)]">
            {busy ? <SpinnerIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" /> : <RocketIcon className="h-3.5 w-3.5" />}
            {busy ? `${t("Working")}…` : t("Idle")}
          </div>
        )}
        {state.usage.input > 0 && (
          <div className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
            {formatTokens(state.usage.input)} / {formatTokens(state.usage.output)} {t("tokens")}
            {state.model ? ` · ${state.model}` : ""}
          </div>
        )}
      </Section>

      <Section title={t("Deliverables")} right={files.length > 0 ? String(files.length) : undefined}>
        {files.length === 0 ? (
          <div className="text-[12px] leading-5 text-[var(--color-ink-faint)]">
            {t("Files the agent creates or edits show up here.")}
          </div>
        ) : (
          <ul className="-mx-1 space-y-0.5">
            {files.map((f) => (
              <DeliverableItem key={f.path} file={f} onOpen={() => onOpenFile(f.path)} />
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}

function DeliverableItem({ file, onOpen }: { file: TouchedFile; onOpen(): void }): React.ReactElement {
  const name = file.path.split("/").pop() ?? file.path;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={file.path}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-dim)] text-[var(--color-accent)]">
          <FileIcon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-[var(--color-ink)]">{name}</span>
          <span className="block truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">{file.path}</span>
        </span>
        <span className="shrink-0 text-right font-mono text-[10.5px]">
          {file.added > 0 && <span className="text-[var(--color-add)]">+{file.added}</span>}
          {file.removed > 0 && <span className="ml-1 text-[var(--color-remove)]">−{file.removed}</span>}
        </span>
      </button>
    </li>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-2.5 flex items-center">
        <span className="text-[12px] font-semibold text-[var(--color-ink)]">{title}</span>
        {right && <span className="ml-auto text-[11px] text-[var(--color-ink-faint)]">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/** Read-only preview of a deliverable; markdown renders, code stays raw. */
export function FilePreview({
  client,
  path,
  onClose,
  onOpenExternally,
}: {
  client: CodepilotClient;
  path: string;
  onClose(): void;
  onOpenExternally?: (path: string) => void;
}): React.ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setContent(null);
    setError(null);
    client
      .readWorkspace(path)
      .then((r) => live && setContent(r.content))
      .catch((err) => live && setError(String(err instanceof Error ? err.message : err)));
    return () => {
      live = false;
    };
  }, [client, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isMarkdown = /\.(md|markdown)$/i.test(path);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-3xl animate-fade-in flex-col overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] px-4 py-2.5">
          <FileIcon className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="min-w-0 truncate font-mono text-[12.5px] text-[var(--color-ink)]">{path}</span>
          <div className="ml-auto flex items-center gap-1">
            {onOpenExternally && (
              <button type="button" className="cp-icon-btn" title={t("Open in editor")} onClick={() => onOpenExternally(path)}>
                <ExternalIcon />
              </button>
            )}
            <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
              <XIcon />
            </button>
          </div>
        </div>
        <div className="min-h-40 overflow-auto p-4">
          {error ? (
            <div className="text-[12.5px] text-[var(--color-remove)]">{error}</div>
          ) : content === null ? (
            <SpinnerIcon className="h-4 w-4 text-[var(--color-accent)]" />
          ) : isMarkdown ? (
            <Markdown text={content} />
          ) : (
            <pre className="font-mono text-[12px] leading-5 whitespace-pre-wrap text-[var(--color-ink)]">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
