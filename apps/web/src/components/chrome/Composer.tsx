import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentMode, FollowUpItem, ImageAttachment, PromptFile } from "@codepilot/core";

import {
  filesFromList,
  imageDataUrl,
  isImageFile,
  readAttachment,
  splitAttachments,
  type PendingAttachment,
} from "../../state/attachments.js";
import { t } from "../../i18n.js";
import { MentionMenu, mentionMenuHandleKey, detectTrigger, applyPick } from "../MentionMenu.js";
import { FileIcon, SendIcon, StopIcon, XIcon } from "../Icons.js";
import { ModeSwitch } from "./ModeSwitch.js";

export interface ComposerProps {
  value: string;
  onChange(v: string): void;
  /** Resolves when the server accepted the prompt. Reject on failure so the
   * composer can restore the draft (avoids lost text + accidental double-send). */
  onSend(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): void | Promise<void>;
  onStop(): void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  mode?: AgentMode;
  modes?: AgentMode[];
  onMode?(m: AgentMode): void;
  size?: "md" | "lg";
  /** Tighten spacing for a narrow IDE sidebar (embedded layout). Reduces the
   * action-row gaps/padding and lets the mode switch compress so the model
   * picker keeps a usable minimum width at ~250px. */
  compact?: boolean;
  autoFocus?: boolean;
  footer?: React.ReactNode;
  followUps?: FollowUpItem[];
  onRemoveFollowUp?(id: string): void;
  /** Pull a queued item back into the composer for editing. */
  onEditFollowUp?(id: string): void;
  /** Inject this queued item into the current run (steer; does not cancel). */
  onSendFollowUpNow?(id: string): void | Promise<void>;
  /** Server-backed `/` command + `@` mention completion. When present the
   * composer shows an autocomplete menu for the `/` and `@` triggers. */
  menuProvider?: import("../MentionMenu.js").MenuProvider;
}

/** Prompt box. Enter sends, Shift+Enter is a newline, Esc stops a run.
 * Images and files can be pasted, dropped, or picked; `@path/to/img.png` in
 * the text is also attached server-side. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled = false,
  placeholder,
  mode,
  modes = [],
  onMode,
  size = "md",
  compact = false,
  autoFocus = false,
  footer,
  followUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
  menuProvider,
}: ComposerProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<import("../MentionMenu.js").Trigger | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Guard against double Enter / double-click while a send is in flight. */
  const sendingRef = useRef(false);

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    setAttachError(null);
    void Promise.all(
      files.map((f) =>
        readAttachment(f).catch((err: unknown) => {
          setAttachError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ),
    ).then((read) =>
      setAttachments((prev) => [...prev, ...read.filter((x): x is PendingAttachment => x !== null)]),
    );
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, size === "lg" ? 260 : 220)}px`;
  }, [value, size]);

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);

  const canSend = !disabled && (value.trim() !== "" || attachments.length > 0);
  const send = (delivery: "auto" | "steer" = "auto"): void => {
    if (sendingRef.current || !canSend) return;
    // Inject-into-run is text-only (attachments stay on the queue path).
    if (delivery === "steer" && attachments.length > 0) return;
    const pendingAttachments = attachments;
    const { images, files } = splitAttachments(pendingAttachments);
    const fallback =
      images.length > 0 && files.length === 0
        ? t("See the attached image.")
        : files.length > 0
          ? t("See the attached file.")
          : t("See the attached image.");
    const text = value.trim() || fallback;
    const resolvedDelivery = busy ? delivery : "auto";
    // Clear optimistically for snappy UX, but restore the draft if the
    // server rejects the send — otherwise the text is lost and a retype
    // often produces a duplicate once the first request actually lands.
    onChange("");
    setAttachments([]);
    setAttachError(null);
    sendingRef.current = true;
    void Promise.resolve(
      onSend(
        text,
        resolvedDelivery === "steer" ? undefined : images.length > 0 ? images : undefined,
        resolvedDelivery === "steer" ? undefined : files.length > 0 ? files : undefined,
        resolvedDelivery,
      ),
    )
      .catch(() => {
        onChange(text);
        setAttachments(pendingAttachments);
      })
      .finally(() => {
        sendingRef.current = false;
      });
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {followUps.length > 0 && (
        <div
          className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)]/80 px-2.5 py-2"
          aria-label={t("Queued messages")}
        >
          <div className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
            {t("Queued")} · {followUps.length}
          </div>
          {followUps.map((fu, i) => (
            <div
              key={fu.id}
              className="group flex items-start gap-1.5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-2 py-1.5"
            >
              <span className="mt-0.5 shrink-0 rounded bg-[var(--color-surface-sunken)] px-1.5 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => onEditFollowUp?.(fu.id)}
                title={t("Edit queued message")}
                className="min-w-0 flex-1 text-left text-[12px] leading-5 text-[var(--color-ink)] hover:text-[var(--color-accent)]"
              >
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{fu.text}</span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
                {onSendFollowUpNow && (
                  <button
                    type="button"
                    onClick={() => {
                      if (sendingRef.current) return;
                      sendingRef.current = true;
                      void Promise.resolve(onSendFollowUpNow(fu.id)).finally(() => {
                        sendingRef.current = false;
                      });
                    }}
                    title={t("Send now (inject into current run)")}
                    aria-label={t("Send now")}
                    className="rounded-md px-1.5 py-1 text-[11px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
                  >
                    {t("Send now")}
                  </button>
                )}
                {onRemoveFollowUp && (
                  <button
                    type="button"
                    aria-label={t("Remove from queue")}
                    onClick={() => onRemoveFollowUp(fu.id)}
                    className="rounded-md p-1 hover:bg-[var(--color-edge)]"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    <div
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (disabled) return;
        const files = filesFromList(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        addFiles(files);
      }}
      className={`relative rounded-2xl border bg-[var(--color-surface-raised)] shadow-sm transition-all focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)] ${
        dragging ? "border-[var(--color-accent)]" : "border-[var(--color-edge)]"
      } ${disabled ? "opacity-60" : ""}`}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <div key={a.id} className="group relative">
              {a.kind === "image" ? (
                <img
                  src={imageDataUrl(a)}
                  alt={a.name}
                  title={a.name}
                  className="h-16 w-16 rounded-lg border border-[var(--color-edge)] object-cover"
                />
              ) : (
                <div
                  title={a.name}
                  className="flex h-16 max-w-[10rem] items-center gap-2 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-2.5"
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-dim)]" />
                  <span className="truncate text-[11px] text-[var(--color-ink)]">{a.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                aria-label={t("Remove attachment")}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <div className="px-4 pt-2 text-[11px] text-[var(--color-remove)]">{attachError}</div>}
      {menuProvider && (
        <MentionMenu
          trigger={trigger}
          provider={menuProvider}
          onClose={() => setTrigger(null)}
          onPick={({ insert, keepOpen }) => {
            if (!trigger) return;
            const applied = applyPick(value, trigger, insert);
            onChange(applied.text);
            // A category pick (keepOpen) keeps the menu up, re-detecting the
            // now `@kind:` trigger so the next keystrokes query that category.
            setTrigger(keepOpen ? detectTrigger(applied.text, applied.caret) : null);
            requestAnimationFrame(() => {
              const el = ref.current;
              if (el) {
                el.focus();
                el.setSelectionRange(applied.caret, applied.caret);
              }
            });
          }}
        />
      )}
      <textarea
        ref={ref}
        value={value}
        rows={1}
        onChange={(e) => {
          onChange(e.target.value);
          if (menuProvider) {
            setTrigger(detectTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length));
          }
        }}
        onClick={(e) => {
          if (menuProvider) {
            const el = e.currentTarget;
            setTrigger(detectTrigger(el.value, el.selectionStart ?? el.value.length));
          }
        }}
        onPaste={(e) => {
          const files = filesFromList(e.clipboardData.files);
          if (files.length === 0) return;
 // Keep text paste when the clipboard has no files; only claim file pastes.
          if (!files.some(isImageFile) && !files.some((f) => f.size > 0)) return;
          e.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(e) => {
 // IME composition (Chinese/Japanese input) uses Enter to commit a
 // candidate; that must not send the message.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // Let the mention/command menu consume navigation + pick keys first.
          if (menuProvider && trigger && mentionMenuHandleKey(e)) {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if ((e.metaKey || e.ctrlKey) && busy) send("steer");
            else send("auto");
          } else if (e.key === "Escape" && busy) {
            e.preventDefault();
            onStop();
          }
        }}
        placeholder={
          placeholder ??
          (busy
            ? t("Queued on Enter · ⌘↵ inject into current run…")
            : t("Ask CodePilot…"))
        }
        disabled={disabled}
        aria-label={t("Prompt")}
        className={`block w-full resize-none bg-transparent px-4 text-[var(--color-ink)] outline-none focus-visible:outline-none placeholder:text-[var(--color-ink-faint)] ${
          size === "lg" ? "min-h-20 pt-4 pb-2 text-[14.5px] leading-6" : "min-h-11 pt-3 pb-1 text-[13px] leading-6"
        }`}
      />
      <div className={`flex items-center px-2.5 pb-2.5 ${compact ? "gap-1" : "gap-2"}`}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(filesFromList(e.target.files));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title={t("Attach files (or paste / drop; @path/to/image.png also works)")}
          aria-label={t("Attach files")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed"
        >
          <FileIcon className="h-4 w-4" />
        </button>
        {modes.length > 1 && mode && onMode && (
          <ModeSwitch mode={mode} modes={modes} onMode={onMode} disabled={disabled} compact={compact} />
        )}
        {/* overflow-visible: ModelPicker menu portals out; truncate clipped it. */}
        <div className="min-w-0 flex-1 overflow-visible text-[11px] text-[var(--color-ink-faint)]">
          {footer}
        </div>
        {busy && (
          <button
            type="button"
            onClick={() => send("steer")}
            disabled={!canSend || attachments.length > 0}
            title={t("Inject into current run (⌘↵)")}
            aria-label={t("Inject into current run")}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-[var(--color-edge)] px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            {t("Inject")}
          </button>
        )}
        {busy ? (
          <>
            <button
              type="button"
              onClick={() => send("auto")}
              disabled={!canSend}
              title={t("Queue for after this run (Enter)")}
              aria-label={t("Queue")}
              className="cp-brand-gradient flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-md shadow-[var(--color-accent-dim)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
            >
              <SendIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onStop}
              title={`${t("Stop")} (Esc)`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] transition-transform hover:scale-105"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => send("auto")}
            disabled={!canSend}
            title={t("Enter to send · Shift+Enter for newline")}
            aria-label={t("Send")}
            className="cp-brand-gradient flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-md shadow-[var(--color-accent-dim)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
    </div>
  );
}