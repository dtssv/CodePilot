import { t } from "../../i18n.js";
import type { Connector, ListTab } from "./types.js";

export type ConnectorsSectionProps = {
  connectors: Connector[];
  connectorsTotal: number;
  connectorTab: ListTab;
  connectorQueryDraft: string;
  setConnectorQueryDraft: (v: string) => void;
  setConnectorQuery: (v: string) => void;
  setConnectorTab: (tab: ListTab) => void;
  setSelected: (c: Connector | null) => void;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setEditCredentials: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (v: string | undefined) => void;
  selected: Connector | null;
  values: Record<string, string>;
  editCredentials: boolean;
  busy: boolean;
  loadConnectors: (opts?: { offset?: number }) => Promise<void>;
  saveConnector: () => Promise<void>;
  toggleConnector: (c: Connector, enabled: boolean) => Promise<void>;
};

  const statusBadge = (c: Connector): React.ReactNode => {
    if (!c.status.installed) {
      return (
        <span className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]">
          {t("Not installed")}
        </span>
      );
    }
    if (!c.status.enabled) {
      return (
        <span className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-warn)]">
          {t("Disabled")}
        </span>
      );
    }
    return (
      <span className="rounded bg-[var(--color-add)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-add)]">
        {t("Installed")}
      </span>
    );
  };

export function ConnectorsSection({
  connectors,
  connectorsTotal,
  connectorTab,
  connectorQueryDraft,
  setConnectorQueryDraft,
  setConnectorQuery,
  setConnectorTab,
  setSelected,
  setValues,
  setEditCredentials,
  setError,
  selected,
  values,
  editCredentials,
  busy,
  loadConnectors,
  saveConnector,
  toggleConnector,
}: ConnectorsSectionProps): React.ReactElement {
  return (
        <div className="space-y-3">
          <p className="text-[12px] leading-5 text-[var(--color-ink-dim)]">
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="cp-input min-w-[12rem] flex-1 text-[12.5px]"
              placeholder={t("Search connectors…")}
              value={connectorQueryDraft}
              onChange={(e) => setConnectorQueryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") setConnectorQuery(connectorQueryDraft.trim());
              }}
            />
            <button
              type="button"
              className="cp-btn-ghost py-1.5 text-[12px]"
              onClick={() => setConnectorQuery(connectorQueryDraft.trim())}
            >
              {t("Search")}
            </button>
            {(["all", "installed"] as ListTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={
                  connectorTab === tab
                    ? "cp-btn py-1 text-[11px]"
                    : "cp-btn-ghost py-1 text-[11px]"
                }
                onClick={() => {
                  setConnectorTab(tab);
                  setSelected(null);
                }}
              >
                {tab === "all" ? t("All") : t("Installed")}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {connectors.map((c) => (
              <button
                key={c.id}
                type="button"
                className="flex flex-col rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-left hover:border-[var(--color-accent)]"
                onClick={() => {
                  setSelected(c);
                  setValues({});
                  setEditCredentials(false);
                  setError(undefined);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--color-ink)]">{c.name}</span>
                  {statusBadge(c)}
                </span>
                <span className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
                  {c.description}
                </span>
              </button>
            ))}
          </div>
          {connectors.length === 0 && (
            <p className="text-[12px] text-[var(--color-ink-faint)]">{t("No connectors found.")}</p>
          )}
          {connectors.length < connectorsTotal && (
            <button
              type="button"
              className="cp-btn-ghost w-full py-2 text-[12px]"
              onClick={() => void loadConnectors({ offset: connectors.length })}
            >
              {t("Load more")} ({connectors.length}/{connectorsTotal})
            </button>
          )}
          {selected && (
            <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-[var(--color-ink)]">{selected.name}</span>
                {statusBadge(selected)}
                {selected.authUrl && (
                  <a
                    className="text-[12px] text-[var(--color-accent)] underline"
                    href={selected.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Open authorisation")}
                  </a>
                )}
                {selected.docsUrl && (
                  <a
                    className="text-[12px] text-[var(--color-ink-faint)] underline"
                    href={selected.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Docs")}
                  </a>
                )}
              </div>
              {selected.status.installed ? (
                <>
                  <p className="mb-2 text-[11.5px] leading-4 text-[var(--color-ink-dim)]">
                    {[
                      selected.status.mcpName
                        ? `${t("MCP")}: ${selected.status.mcpName}`
                        : null,
                      selected.status.skillName
                        ? `${t("Skill")}: ${selected.status.skillName}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="cp-btn-ghost"
                      onClick={() => {
                        setSelected(null);
                        setEditCredentials(false);
                      }}
                    >
                      {t("Close")}
                    </button>
                    {selected.status.mcpName && (
                      <button
                        type="button"
                        className="cp-btn"
                        disabled={busy}
                        onClick={() => void toggleConnector(selected, !selected.status.enabled)}
                      >
                        {selected.status.enabled ? t("Disable") : t("Enable")}
                      </button>
                    )}
                    {selected.credentials.length > 0 && (
                      <button
                        type="button"
                        className="cp-btn-ghost"
                        onClick={() => {
                          setEditCredentials((v) => !v);
                          setValues({});
                        }}
                      >
                        {editCredentials ? t("Hide credentials") : t("Update credentials")}
                      </button>
                    )}
                  </div>
                  {editCredentials && (
                    <div className="mt-3 border-t border-[var(--color-edge-subtle)] pt-3">
                      <p className="mb-2 text-[11.5px] text-[var(--color-ink-faint)]">
                        {t("Leave blank to keep current value")}
                      </p>
                      {selected.credentials.map((f) => (
                        <label key={f.key} className="mb-2 block">
                          <span className="cp-eyebrow">{f.label}</span>
                          <input
                            className="cp-input mt-0.5 w-full font-mono text-[12px]"
                            type={f.secret ? "password" : "text"}
                            placeholder={t("Leave blank to keep current value")}
                            value={values[f.key] ?? ""}
                            onChange={(e) =>
                              setValues((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          className="cp-btn"
                          disabled={busy}
                          onClick={() => void saveConnector()}
                        >
                          {t("Save changes")}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-3 text-[11.5px] leading-4 text-[var(--color-warn)]">
                    {selected.securityNotice}
                  </p>
                  {selected.credentials.map((f) => (
                    <label key={f.key} className="mb-2 block">
                      <span className="cp-eyebrow">{f.label}</span>
                      <input
                        className="cp-input mt-0.5 w-full font-mono text-[12px]"
                        type={f.secret ? "password" : "text"}
                        placeholder={f.placeholder}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="cp-btn-ghost"
                      onClick={() => setSelected(null)}
                    >
                      {t("Cancel")}
                    </button>
                    <button
                      type="button"
                      className="cp-btn"
                      disabled={busy}
                      onClick={() => void saveConnector()}
                    >
                      {t("Install connector")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
  );
}
