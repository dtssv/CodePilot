/**
 * First-run guide for the web / desktop surface — the counterpart to the TUI's
 * SetupWizard. It opens once when the shared config has no `onboardedAt` marker
 * (i.e. no client has completed setup yet) and points the user at Settings to
 * connect a provider and pick a search backend. Finishing OR dismissing stamps
 * the marker in the shared config, so no client re-shows it.
 */
import { useEffect, useState } from "react";

import type { Codepilot } from "../state/useCodepilot.js";
import { t } from "../i18n.js";

export function OnboardingGuide({
  cp,
  onOpenSettings,
}: {
  cp: Codepilot;
  onOpenSettings(): void;
}): React.ReactElement | null {
  const { client, state } = cp;
  const [show, setShow] = useState(false);
  const [checked, setChecked] = useState(false);

  // Check the shared onboarding marker once connected.
  useEffect(() => {
    if (checked || state.connection !== "connected") return;
    let alive = true;
    void client
      .getConfig(state.cwd || undefined)
      .then((cfg) => {
        if (!alive) return;
        setChecked(true);
        if (!cfg.active?.onboardedAt) setShow(true);
      })
      .catch(() => {
        if (alive) setChecked(true);
      });
    return () => {
      alive = false;
    };
  }, [checked, client, state.connection, state.cwd]);

  const stamp = async (): Promise<void> => {
    try {
      await client.setOnboarded();
    } catch {
      // Best-effort; a failure just means the guide may re-open, harmless.
    }
  };

  if (!show) return null;

  const dismiss = (): void => {
    setShow(false);
    void stamp();
  };

  const openSettings = (): void => {
    setShow(false);
    void stamp();
    onOpenSettings();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("Welcome to CodePilot")}
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-5 shadow-xl">
        <div className="text-[15px] font-semibold text-[var(--color-ink)]">
          {t("Welcome to CodePilot")}
        </div>
        <div className="mt-2 space-y-2 text-[12.5px] leading-5 text-[var(--color-ink-dim)]">
          <p>{t("Let's get you set up. These are optional and can be changed anytime in Settings:")}</p>
          <ul className="list-disc space-y-1 pl-5 text-[var(--color-ink-faint)]">
            <li>{t("Provider — connect a model (needed to chat)")}</li>
            <li>{t("Web search — keyless default, or pick a stronger engine")}</li>
            <li>{t("Image generation — off by default, opt in here")}</li>
          </ul>
          <p className="text-[11.5px] text-[var(--color-ink-faint)]">
            {t("Settings are shared across all CodePilot clients on this machine.")}
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="cp-btn-ghost py-1.5 text-[12px]" onClick={dismiss}>
            {t("Skip for now")}
          </button>
          <button type="button" className="cp-btn py-1.5 text-[12px]" onClick={openSettings}>
            {t("Open Settings")}
          </button>
        </div>
      </div>
    </div>
  );
}
