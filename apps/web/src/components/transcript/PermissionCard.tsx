import { useEffect, useRef, useState } from "react";

import type { PermissionResolution } from "@codepilot/core";
import type { PendingPermission } from "../../protocol/client.js";
import { t } from "../../i18n.js";
import { localizePermissionReason } from "../../permissionReason.js";
import { CheckIcon, ShieldIcon } from "../Icons.js";
import { CategoryIcon } from "./icons.js";
import { formatInput } from "./Steps.js";

/**
 * Tool approval, rendered at the end of the transcript (not a modal) so the
 * user can still scroll and read what led to the request. The command is
 * shown verbatim and untruncated: approving something you cannot fully read
 * is exactly what this card exists to prevent.
 */
export function PermissionCard({
  req,
  onDecide,
}: {
  req: PendingPermission;
  onDecide(resolution: PermissionResolution): void;
}): React.ReactElement {
  const allowRef = useRef<HTMLButtonElement>(null);
  // Decline-with-feedback: when the user clicks "Deny with feedback", reveal a
  // textarea whose contents ride back as the tool result the model sees.
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => allowRef.current?.focus(), [req.requestId]);
  useEffect(() => {
    if (feedbackMode) feedbackRef.current?.focus();
  }, [feedbackMode]);
  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-surface-raised)] shadow-lg shadow-black/10">
      <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-warn-dim)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
        <ShieldIcon className="h-3.5 w-3.5" />
        <span className="font-semibold">{t("Permission required")}</span>
        <span className="text-[var(--color-ink-dim)]">· {t("CodePilot wants to run")}</span>
        <span className="cp-chip">
          <CategoryIcon name={req.toolName} className="h-3 w-3" />
          {req.toolName}
        </span>
      </div>
      <div className="p-3">
        {req.reason && (
          <div className="mb-2 text-[12px] text-[var(--color-ink-dim)]">
            {localizePermissionReason(req.reason)}
          </div>
        )}
        {req.preview ? (
          <pre className="mb-2 max-h-72 overflow-auto rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] p-2.5 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-[var(--color-ink)]">
            {req.preview}
          </pre>
        ) : null}
        <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] p-2.5 text-[11.5px] leading-5 whitespace-pre-wrap text-[var(--color-ink)]">
          {formatInput(req.input)}
        </pre>
        {feedbackMode ? (
          <div className="mt-3">
            <label className="mb-1 block text-[11px] text-[var(--color-ink-dim)]">
              {t("Deny and tell the model what to do instead")}
            </label>
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  onDecide(
                    feedback.trim().length > 0 ? { decision: "deny", feedback: feedback.trim() } : "deny",
                  );
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setFeedbackMode(false);
                  setFeedback("");
                }
              }}
              rows={3}
              placeholder={t("e.g. don't edit that file, edit src/app.ts instead")}
              className="w-full rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] p-2 text-[12px] text-[var(--color-ink)] outline-none focus:border-[var(--color-warn)]"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setFeedbackMode(false);
                  setFeedback("");
                }}
                className="cp-btn-ghost"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={() =>
                  onDecide(
                    feedback.trim().length > 0 ? { decision: "deny", feedback: feedback.trim() } : "deny",
                  )
                }
                className="cp-btn-danger"
              >
                {t("Send feedback")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => setFeedbackMode(true)} className="cp-btn-ghost">
              {t("Deny with feedback")}
            </button>
            <button
              type="button"
              onClick={() => onDecide({ decision: "abort" })}
              title={t("Refuse this call and stop the whole turn")}
              className="cp-btn-ghost"
            >
              {t("Deny & stop")}
            </button>
            <button type="button" onClick={() => onDecide("deny")} className="cp-btn-danger">
              {t("Deny")}
            </button>
            {!req.sandboxExpand && !req.sandboxEscalation ? (
              <button
                type="button"
                onClick={() => onDecide("always-project")}
                title={t("Save this rule to the project config so it applies in future sessions")}
                className="cp-btn-ghost"
              >
                {t("Always (project)")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onDecide("always")}
              title={
                req.sandboxExpand
                  ? t("Save this folder to sandbox.writablePaths for future sessions")
                  : req.sandboxEscalation
                    ? t("Remember this unsandboxed pattern for this session")
                    : "Remember this command pattern for this session — other commands still ask"
              }
              className="cp-btn-ghost"
            >
              {req.sandboxExpand
                ? t("Always allow folder")
                : req.sandboxEscalation
                  ? t("Always allow unsandboxed")
                  : t("Always allow")}
            </button>
            <button ref={allowRef} type="button" onClick={() => onDecide("allow")} className="cp-btn-primary">
              <CheckIcon className="h-3 w-3" />
              {req.sandboxExpand ? t("Allow folder once") : t("Allow once")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}