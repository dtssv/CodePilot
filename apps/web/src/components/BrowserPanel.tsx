// In-app browser panel for the desktop app. Renders an Electron <webview>
// so http(s) links open inside the window instead of an external browser.
// Only mounted when `window.__codepilotOpenBrowser` consumers are active
// (i.e. the desktop surface with webviewTag enabled).

import { useEffect, useRef, useState } from "react";

import { t } from "../i18n.js";
import { ArrowRightIcon, RefreshIcon, XIcon } from "./Icons.js";

/** Minimal typing for the Electron <webview> element we use. */
interface WebviewEl extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
}

export function BrowserPanel({
  url,
  onClose,
  onOpenExternally,
}: {
  url: string;
  onClose(): void;
  onOpenExternally?(url: string): void;
}): React.ReactElement {
  const viewRef = useRef<WebviewEl | null>(null);
  const [address, setAddress] = useState(url);
  const [current, setCurrent] = useState(url);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  // Navigate when the requested url prop changes (new link clicked).
  useEffect(() => {
    setAddress(url);
    setCurrent(url);
    const v = viewRef.current;
    if (v && v.src !== url) v.src = url;
  }, [url]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const syncNav = (): void => {
      try {
        setCanBack(v.canGoBack());
        setCanForward(v.canGoForward());
        setCurrent(v.getURL());
        setAddress(v.getURL());
      } catch {
        /* webview not ready */
      }
    };
    const onStart = (): void => setLoading(true);
    const onStop = (): void => {
      setLoading(false);
      syncNav();
    };
    const onTitle = (e: Event): void => setTitle((e as unknown as { title: string }).title ?? "");
    v.addEventListener("did-start-loading", onStart);
    v.addEventListener("did-stop-loading", onStop);
    v.addEventListener("did-navigate", syncNav);
    v.addEventListener("did-navigate-in-page", syncNav);
    v.addEventListener("page-title-updated", onTitle as EventListener);
    return () => {
      v.removeEventListener("did-start-loading", onStart);
      v.removeEventListener("did-stop-loading", onStop);
      v.removeEventListener("did-navigate", syncNav);
      v.removeEventListener("did-navigate-in-page", syncNav);
      v.removeEventListener("page-title-updated", onTitle as EventListener);
    };
  }, []);

  const go = (raw: string): void => {
    let next = raw.trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) next = `https://${next}`;
    setCurrent(next);
    const v = viewRef.current;
    if (v) v.src = next;
  };

  return (
    <aside className="flex w-[30rem] shrink-0 flex-col border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-subtle)] px-2">
        <button
          type="button"
          className="cp-icon-btn"
          title={t("Back")}
          disabled={!canBack}
          onClick={() => viewRef.current?.goBack()}
        >
          <ArrowRightIcon className="h-4 w-4 rotate-180" />
        </button>
        <button
          type="button"
          className="cp-icon-btn"
          title={t("Forward")}
          disabled={!canForward}
          onClick={() => viewRef.current?.goForward()}
        >
          <ArrowRightIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="cp-icon-btn"
          title={loading ? t("Stop") : t("Reload")}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          <RefreshIcon className="h-4 w-4" />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
          }}
        >
          <input
            className="cp-input w-full py-1 text-[12px]"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            aria-label={t("Address")}
          />
        </form>
        {onOpenExternally && (
          <button
            type="button"
            className="cp-icon-btn"
            title={t("Open in external browser")}
            onClick={() => onOpenExternally(current)}
          >
            <ArrowRightIcon className="h-4 w-4 -rotate-45" />
          </button>
        )}
        <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      {title && (
        <div className="truncate border-b border-[var(--color-edge-subtle)] px-3 py-1 text-[11px] text-[var(--color-ink-faint)]">
          {title}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <webview
          ref={viewRef as unknown as React.Ref<HTMLElement>}
          src={url}
          className="absolute inset-0 h-full w-full"
          // Isolated partition so the in-app browser keeps its own cookies.
          partition="persist:codepilot-browser"
        />
        {loading && (
          <div className="absolute left-0 right-0 top-0 h-0.5 animate-pulse bg-[var(--color-accent)]" />
        )}
      </div>
    </aside>
  );
}
