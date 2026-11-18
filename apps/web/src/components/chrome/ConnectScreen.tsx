import { useState } from "react";

import type { AppState } from "../../state/reducer.js";
import { t } from "../../i18n.js";
import { AlertIcon, ArrowRightIcon, LogoMark } from "../Icons.js";
import { ConnectionPill } from "./ConnectionPill.js";

export function ConnectScreen({
  state,
  defaultUrl,
  defaultToken,
  onConnect,
  topRight,
}: {
  state: AppState;
  defaultUrl: string;
  defaultToken: string;
  onConnect(o: { url: string; token: string }): void;
  topRight?: React.ReactNode;
}): React.ReactElement {
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState(defaultToken);
  const connecting = state.connection === "connecting";

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-[var(--color-bg)] p-6">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(60%_50%_at_50%_0%,var(--color-accent-dim),transparent)]" />
      <div className="absolute top-3 right-3 flex items-center gap-2">{topRight}</div>
      <form
        className="relative w-full max-w-md animate-fade-in rounded-2xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface)] p-7 shadow-xl shadow-black/10"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect({ url, token });
        }}
      >
        <div className="mb-6 flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <div className="text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">{t("Connect to CodePilot")}</div>
            <ConnectionPill state={state} />
          </div>
        </div>
        <p className="mb-2 text-[12.5px] leading-5 text-[var(--color-ink-dim)]">
          {t("Run the command below, then paste the URL it prints. Open a workspace folder after connecting.")}
        </p>
        <code className="mb-5 block rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-3 py-2 font-mono text-[12px] text-[var(--color-ink)]">
          codepilot serve --web --web-root
        </code>
        <Field label={t("Server")} value={url} onChange={setUrl} placeholder="ws://127.0.0.1:18765/rpc" />
        <Field label={t("Token")} value={token} onChange={setToken} placeholder="from `codepilot serve --web`" secret />
        {state.connectionError && (
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-[var(--color-remove-dim)] px-3 py-2 text-[12px] text-[var(--color-remove)]">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{state.connectionError}</span>
          </div>
        )}
        <button type="submit" disabled={connecting} className="cp-btn-primary w-full py-2 text-[13px]">
          {connecting ? t("Connecting…") : t("Connect")}
          {!connecting && <ArrowRightIcon className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  secret?: boolean;
  ariaLabel?: string;
}): React.ReactElement {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11.5px] font-medium text-[var(--color-ink-dim)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        type={secret ? "password" : "text"}
        spellCheck={false}
        className="cp-input w-full font-mono text-[12.5px]"
      />
    </label>
  );
}