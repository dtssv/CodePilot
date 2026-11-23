import { t } from "../../i18n.js";
import type { Codepilot } from "../../state/useCodepilot.js";

export type RemoteSectionProps = {
  cp: Codepilot;
  state: Codepilot["state"];
  pairCwds: string[];
  togglePairCwd: (cwd: string) => void;
  busy: boolean;
  mintQr: () => Promise<void>;
  qr: {
    url: string;
    code: string;
    expiresAt: number;
    qrDataUrl: string;
  } | null;
  revokeAllRemote: () => Promise<void>;
};

export function RemoteSection({
  cp,
  state,
  pairCwds,
  togglePairCwd,
  busy,
  mintQr,
  qr,
  revokeAllRemote,
}: RemoteSectionProps): React.ReactElement {
  return (
        <div className="space-y-3">
          {cp.workspaces.length > 1 && (
            <div className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
              <div className="text-[13px] font-medium text-[var(--color-ink)]">
                {t("Workspaces to authorize")}
              </div>
              <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                {cp.workspaces.map((ws) => {
                  const isActive = ws === state.cwd;
                  const label = ws.split("/").filter(Boolean).pop() || ws;
                  return (
                    <label
                      key={ws}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-[var(--color-surface-hover)]"
                      title={ws}
                    >
                      <input
                        type="checkbox"
                        checked={pairCwds.includes(ws)}
                        disabled={isActive}
                        onChange={() => togglePairCwd(ws)}
                      />
                      <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{label}</span>
                      {isActive && (
                        <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                          {t("active")}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <button
            type="button"
            className="cp-btn"
            disabled={busy || state.connection !== "connected"}
            onClick={() => void mintQr()}
          >
            {t("Generate one-time QR")}
          </button>
          {qr && (
            <div className="flex flex-col items-center rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] p-4">
              <img src={qr.qrDataUrl} alt="QR" className="h-[200px] w-[200px] rounded-lg bg-white p-2" />
              <div className="mt-2 text-[12px] text-[var(--color-ink)]">
                {t("Code")}: <span className="font-mono">{qr.code}</span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
                {t("Expires")}: {new Date(qr.expiresAt).toLocaleTimeString()}
              </div>
              <p className="mt-2 max-w-sm break-all text-center font-mono text-[10px] text-[var(--color-ink-faint)]">
                {qr.url}
              </p>
            </div>
          )}
          <button
            type="button"
            className="cp-btn-ghost text-[var(--color-remove)]"
            disabled={busy}
            onClick={() => void revokeAllRemote()}
          >
            {t("Revoke all remote access")}
          </button>
        </div>
  );
}
