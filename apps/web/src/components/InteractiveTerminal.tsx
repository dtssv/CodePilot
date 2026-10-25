/**
 * Interactive PTY terminal (xterm.js) backed by protocol terminal/* RPCs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import type { CodepilotClient } from "../protocol/client.js";
import { describeError } from "../protocol/client.js";
import { t } from "../i18n.js";

type ShellInfo = { id: string; path: string; label: string };
type HostPlatform = "darwin" | "linux" | "win32" | "other";

function platformLabel(platform: HostPlatform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return platform;
}

export function InteractiveTerminal({
  client,
  cwd,
  connected,
  autoStart = true,
}: {
  client: CodepilotClient;
  cwd: string;
  connected: boolean;
  autoStart?: boolean;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [platform, setPlatform] = useState<HostPlatform>("other");
  const [shellId, setShellId] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "exited">("idle");
  const [error, setError] = useState<string | undefined>();
  const [shellPath, setShellPath] = useState<string>("");

  const disposeTerm = useCallback(() => {
    const id = termIdRef.current;
    termIdRef.current = null;
    if (id) void client.closeTerminal(id).catch(() => {});
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, [client]);

  useEffect(() => {
    if (!connected) return;
    void client
      .listTerminalShells()
      .then((r) => {
        setPlatform(r.platform);
        setShells(r.shells);
        setShellId((prev) => prev || r.shells[0]?.id || "");
      })
      .catch((err) => setError(describeError(err)));
  }, [client, connected]);

  useEffect(() => {
    return () => {
      disposeTerm();
      client.setTerminalHandlers(null);
    };
  }, [client, disposeTerm]);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const id = termIdRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    if (id) {
      void client.resizeTerminal(id, term.cols, term.rows).catch(() => {});
    }
  }, [client]);

  const start = useCallback(async () => {
    if (!connected || !hostRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(undefined);
    setStatus("starting");
    disposeTerm();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    client.setTerminalHandlers({
      onData: (p) => {
        if (p.terminalId !== termIdRef.current) return;
        term.write(p.data);
      },
      onExit: (p) => {
        if (p.terminalId !== termIdRef.current) return;
        term.writeln(`\r\n[process exited: ${p.exitCode}]`);
        setStatus("exited");
        termIdRef.current = null;
      },
    });

    try {
      const shell = shells.find((s) => s.id === shellId);
      const opened = await client.openTerminal({
        shell: shell?.path ?? (shellId || undefined),
        cwd: cwd || undefined,
        cols: Math.max(term.cols, 40),
        rows: Math.max(term.rows, 12),
      });
      termIdRef.current = opened.terminalId;
      setShellPath(opened.shell);
      setStatus("running");
      term.onData((data) => {
        const id = termIdRef.current;
        if (!id) return;
        void client.writeTerminal(id, data).catch((err) => {
          setError(describeError(err));
        });
      });
      requestAnimationFrame(() => {
        fitAndResize();
        term.focus();
      });
    } catch (err) {
      setError(describeError(err));
      setStatus("idle");
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      client.setTerminalHandlers(null);
    } finally {
      startingRef.current = false;
    }
  }, [client, connected, cwd, disposeTerm, fitAndResize, shellId, shells]);

  useEffect(() => {
    if (!autoStart || !connected || !shellId || shells.length === 0) return;
    if (autoStartedRef.current || status !== "idle") return;
    autoStartedRef.current = true;
    const timer = window.setTimeout(() => void start(), 80);
    return () => window.clearTimeout(timer);
  }, [autoStart, connected, shellId, shells.length, start, status]);

  useEffect(() => {
    if (!hostRef.current) return;
    const ro = new ResizeObserver(() => fitAndResize());
    ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, [fitAndResize, status]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-[#161b22] px-3 py-1.5">
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/70">
          {platformLabel(platform)}
        </span>
        <select
          className="cp-input max-w-[12rem] border-white/10 bg-[#0d1117] py-0.5 text-[11px] text-[#e6edf3]"
          value={shellId}
          disabled={status === "running" || status === "starting"}
          onChange={(e) => setShellId(e.target.value)}
          aria-label={t("Shell")}
        >
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          {shells.length === 0 && <option value="">{t("No shell found")}</option>}
        </select>
        {status === "running" || status === "starting" ? (
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => {
              disposeTerm();
              setStatus("idle");
              client.setTerminalHandlers(null);
            }}
          >
            {t("Close")}
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
            disabled={!connected || !shellId}
            onClick={() => void start()}
          >
            {status === "exited" ? t("Restart") : t("Open")}
          </button>
        )}
        {shellPath && (
          <span className="truncate font-mono text-[10px] text-white/40" title={shellPath}>
            {shellPath}
          </span>
        )}
        <span className="ml-auto text-[10px] text-white/40">
          {status === "running"
            ? t("Interactive — Tab completes in the shell")
            : status === "starting"
              ? t("Starting…")
              : status === "exited"
                ? t("Exited")
                : t("Click Open to start")}
        </span>
      </div>
      {error && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
