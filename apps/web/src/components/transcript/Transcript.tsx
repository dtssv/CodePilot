import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { endsInError, formatTokens, groupRows, type Block, type TurnPart } from "../../state/selectors.js";
import { t } from "../../i18n.js";
import { stripThinking } from "../../state/stripThinking.js";
import { LogoMark } from "../Icons.js";
import { Markdown } from "../Markdown.js";
import { InsertCodeContext, OpenPathContext, SubagentContext } from "./contexts.js";
import { SubagentStateIcon } from "./icons.js";
import {
  ActivityRow,
  CopyButton,
  MessageView,
  MiscRow,
  ReasoningBlock,
  SteerChip,
  ThinkingRow,
} from "./MessageViews.js";
import { PermissionCard } from "./PermissionCard.js";
import { PlanCard, PlanMarker } from "./Plan.js";
import { QuestionCard } from "./QuestionCard.js";
import { SelectionActions } from "./SelectionActions.js";
import { StepGroup, subagentTag } from "./Steps.js";
import type { Density, SubagentNav, TranscriptProps } from "./types.js";

export function Transcript(props: TranscriptProps): React.ReactElement {
  const [viewing, setViewing] = useState<{ toolCallId: string; index: number } | undefined>();
  const runs = props.subagents ?? {};
  const run = viewing ? runs[viewing.toolCallId]?.find((r) => r.index === viewing.index) : undefined;

  // Remember each view's scroll offset so drilling into a sub-agent and back
  // does not drag the main task view to the sub-agent's position. Keyed by
  // `${sessionId}:main` or `${sessionId}:${toolCallId}:${index}`.
  const scrollRef = props.scrollContainerRef;
  const sessionScope = props.sessionId ?? "";
  const savedScroll = useRef<Map<string, number>>(new Map());
  const prevKey = useRef<string>(`${sessionScope}:main`);
  const skipRestore = useRef(false);
  const viewKey = viewing
    ? `${sessionScope}:${viewing.toolCallId}:${viewing.index}`
    : `${sessionScope}:main`;
  // Leave any sub-agent drill-down when the session changes. Sticky scroll
  // owns landing at the bottom — do not restore a previous view's offset.
  useEffect(() => {
    skipRestore.current = true;
    setViewing(undefined);
    prevKey.current = `${sessionScope}:main`;
  }, [sessionScope]);
  const open = (toolCallId: string, index: number): void => {
    const el = scrollRef?.current;
    if (el) savedScroll.current.set(prevKey.current, el.scrollTop);
    setViewing({ toolCallId, index });
  };
  const back = (): void => {
    const el = scrollRef?.current;
    if (el) savedScroll.current.set(prevKey.current, el.scrollTop);
    setViewing(undefined);
  };
  useEffect(() => {
    if (skipRestore.current) {
      skipRestore.current = false;
      prevKey.current = viewKey;
      return;
    }
    const el = scrollRef?.current;
    if (!el) return;
    // Restore after the new view has laid out; default sub-agent views to the
    // top (where their first message is) and the main view to its saved spot.
    const isMain = viewKey.endsWith(":main");
    const target = savedScroll.current.get(viewKey) ?? (isMain ? el.scrollTop : 0);
    requestAnimationFrame(() => {
      el.scrollTop = target;
    });
    prevKey.current = viewKey;
  }, [viewKey, scrollRef]);

  const nav: SubagentNav = { runs, open };

  if (!run) {
    return (
      <OpenPathContext.Provider value={props.onOpenPath}>
        <InsertCodeContext.Provider value={props.onInsertCode}>
          <SubagentContext.Provider value={nav}>
            <MainTranscript {...props} />
          </SubagentContext.Provider>
        </InsertCodeContext.Provider>
      </OpenPathContext.Provider>
    );
  }
  return (
    <OpenPathContext.Provider value={props.onOpenPath}>
      <div className="flex flex-col gap-3">
        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12px]">
          <button
            type="button"
            onClick={back}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]"
          >
            ← {t("Back to main task")}
          </button>
          <SubagentStateIcon state={run.state} />
          <span className="min-w-0 truncate text-[var(--color-ink)]" title={run.objective}>
            {t("Subtask")} {subagentTag(viewing!.toolCallId, run)}: {run.objective}
          </span>
          {(run.view.usage.input > 0 || run.view.usage.output > 0) && (
            <span className="ml-auto shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">
              {formatTokens(run.view.usage.input)} / {formatTokens(run.view.usage.output)} {t("tokens")}
            </span>
          )}
        </div>
        <Transcript
          {...props}
          rows={run.view.rows}
          status={run.state === "running" ? "thinking" : "idle"}
          activity={run.view.activity}
          subagents={run.view.subagents}
          planInline
        />
      </div>
    </OpenPathContext.Provider>
  );
}

function MainTranscript({
  rows,
  status,
  permission,
  question,
  activity,
  plan,
  density = "comfortable",
  planInline = true,
  onDecide,
  onAnswer,
  onRetry,
  onAddToChat,
}: TranscriptProps): React.ReactElement {
  // Grouping is O(rows); memoize so it only recomputes when the rows array
  // identity changes, not on every status/activity re-render during streaming.
  const blocks = useMemo(() => groupRows(rows), [rows]);
  const rootRef = useRef<HTMLDivElement>(null);
  const busy = status !== "idle";
  const last = blocks[blocks.length - 1];
  const lastTurn = last?.kind === "assistant_turn" ? last : undefined;
  const toolsRunning =
    lastTurn?.parts.some((p) => p.kind === "steps" && p.tools.some((x) => x.status === "running")) ?? false;
  const answerStreaming =
    lastTurn?.parts.some((p) => p.kind === "message" && p.msg.streaming) ?? false;
  const retrying =
    lastTurn?.parts.some((p) => p.kind === "row" && p.row.kind === "retry") ?? false;
  const showThinking =
    status === "thinking" &&
    !answerStreaming &&
    !retrying &&
    (!toolsRunning || activity?.phase === "tools");
  const canRetry = !busy && endsInError(rows);

  return (
    <div ref={rootRef} className={`relative flex flex-col ${density === "compact" ? "gap-3" : "gap-4"}`}>
      {blocks.map((b, i) => (
        <BlockView
          key={b.key}
          block={b}
          density={density}
          planInline={planInline}
          isLast={i === blocks.length - 1}
          busy={busy}
          canRetry={canRetry && i === blocks.length - 1}
          onRetry={onRetry}
        />
      ))}
      {showThinking && <ActivityRow activity={activity} plan={plan} />}
      {status === "compacting" && <ThinkingRow label={t("Compacting context")} />}
      {permission && <PermissionCard req={permission} onDecide={onDecide} />}
      {question && <QuestionCard req={question} onAnswer={onAnswer} />}
      <SelectionActions rootRef={rootRef} onAddToChat={onAddToChat} />
    </div>
  );
}

function BlockView({
  block,
  density,
  planInline,
  isLast,
  busy,
  canRetry,
  onRetry,
}: {
  block: Block;
  density: Density;
  planInline: boolean;
  isLast: boolean;
  busy: boolean;
  canRetry: boolean;
  onRetry(): void;
}): React.ReactElement | null {
  switch (block.kind) {
    case "message":
      return <MessageView msg={block.msg} density={density} />;
    case "assistant_turn":
      return (
        <AssistantTurnView
          parts={block.parts}
          density={density}
          planInline={planInline}
          live={isLast && busy}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      );
  }
}

/** One left avatar for the whole post-user turn (tools + all assistant texts). */
function AssistantTurnView({
  parts,
  density,
  planInline,
  live,
  canRetry,
  onRetry,
}: {
  parts: TurnPart[];
  density: Density;
  planInline: boolean;
  live: boolean;
  canRetry: boolean;
  onRetry(): void;
}): React.ReactElement | null {
  const onOpenPath = useContext(OpenPathContext);
  const onInsertCode = useContext(InsertCodeContext);
  if (parts.length === 0) return null;
  const messages = parts.filter((p): p is Extract<typeof p, { kind: "message" }> => p.kind === "message");
  const streaming = messages.some((m) => m.msg.streaming);
  const copyText = messages
    .map((m) => stripThinking(m.msg.text))
    .filter((t) => t.trim() !== "")
    .join("\n\n");
  const model = [...messages].reverse().find((m) => m.msg.model)?.msg.model;

  return (
    <div className="group flex animate-fade-in gap-3">
      {density === "comfortable" && <LogoMark size={24} className="mt-0.5 shrink-0" />}
      <div className={`min-w-0 flex-1 ${density === "compact" ? "space-y-2" : "space-y-3"}`}>
        {parts.map((p, i) => {
          switch (p.kind) {
            case "message":
              return (
                <div key={p.msg.id}>
                  {p.msg.reasoning ? (
                    <ReasoningBlock text={p.msg.reasoning} streaming={p.msg.streaming ?? false} />
                  ) : null}
                  <Markdown text={p.msg.text} onOpenPath={onOpenPath} onInsertCode={onInsertCode} final={!p.msg.streaming} />
                  {p.msg.streaming && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-breathe rounded-sm bg-[var(--color-accent)] align-text-bottom" />
                  )}
                </div>
              );
            case "steer":
              return <SteerChip key={`steer-${p.msg.id}`} text={p.msg.text} density={density} />;
            case "steps":
              return <StepGroup key={`s-${p.tools[0]?.id ?? i}`} tools={p.tools} live={live} />;
            case "plan":
              return p.latest && planInline ? (
                <PlanCard key={`p-${i}`} steps={p.steps} />
              ) : (
                <PlanMarker key={`p-${i}`} steps={p.steps} />
              );
            case "row":
              return (
                <MiscRow
                  key={`r-${p.row.kind}-${p.row.at}`}
                  row={p.row}
                  canRetry={canRetry && i === parts.length - 1}
                  onRetry={onRetry}
                />
              );
          }
        })}
        {!streaming && (copyText || model) && (
          <div className="flex h-5 items-center gap-2 text-[11px] text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100">
            {copyText ? <CopyButton text={copyText} /> : null}
            {model && <span className="font-mono">{model}</span>}
          </div>
        )}
      </div>
    </div>
  );
}