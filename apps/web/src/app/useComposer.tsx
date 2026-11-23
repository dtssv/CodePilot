import { useEffect, useRef, useState } from "react";
import type { ImageAttachment, PromptFile } from "@codepilot/core";
import { UsageLine } from "../components/Chrome.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { ContextGauge } from "../components/ContextGauge.js";
import { interpretSlash } from "../state/slashCommands.js";
import {
  newComposerRef,
  type ComposerRef,
} from "../state/composerRefs.js";
import type { Codepilot } from "../state/useCodepilot.js";
import { t } from "../i18n.js";

/** Local commands that remain TUI-only on this surface (never advertised in `/`). */
const WEB_UNSUPPORTED_LOCAL = new Set([
  "setup",
  "connect",
  "vim",
  "web",
  "remote",
  "exit",
]);

export function useComposer(cp: Codepilot, draft: string, setDraft: (v: string) => void, placeholder?: string) {
  const { state } = cp;
  const busy = state.status !== "idle";
  const [refs, setRefs] = useState<ComposerRef[]>([]);
  // Cache of known LOCAL command names (kind === "local") from the commands/list
  // RPC, so a local command this surface can't run is reported as unsupported
  // instead of leaking to the model. Fetched lazily on first slash use.
  const localNames = useRef<ReadonlySet<string> | null>(null);
  // Prompt-expanding commands (markdown + MCP) — expanded via commands/expand
  // before the turn so raw `/name` never reaches the model.
  const promptCommands = useRef<ReadonlyMap<string, { argumentHint?: string }> | null>(null);

  useEffect(() => {
    const onAdd = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ path: string; startLine?: number; endLine?: number }>).detail;
      if (!detail?.path) return;
      const next = newComposerRef(detail);
      setRefs((prev) => [...prev.filter((r) => r.id !== next.id), next]);
    };
    window.addEventListener("codepilot:add-ref", onAdd);
    return () => window.removeEventListener("codepilot:add-ref", onAdd);
  }, []);

  return {
    value: draft,
    onChange: setDraft,
    refs,
    onRefsChange: setRefs,
    onSend: async (
      text: string,
      images?: ImageAttachment[],
      files?: PromptFile[],
      delivery?: "auto" | "queue" | "steer",
    ) => {
      // Slash commands are LOCAL actions first (switch mode / compact / clear /
      // pickers), not prompts — only trailing args (or unknown md commands)
      // reach the model. Attachments bypass interpretation (they can't be a
      // command).
      if (text.startsWith("/") && (!images || images.length === 0) && (!files || files.length === 0)) {
        if (!localNames.current || !promptCommands.current) {
          try {
            const r = await cp.client.commandsList(state.cwd || undefined);
            localNames.current = new Set(r.commands.filter((c) => c.kind === "local").map((c) => c.name));
            promptCommands.current = new Map(
              r.commands
                .filter((c) => c.kind === "prompt")
                .map((c) => [c.name.toLowerCase(), { argumentHint: c.argumentHint }]),
            );
          } catch {
            localNames.current = new Set();
            promptCommands.current = new Map();
          }
        }
        const outcome = await interpretSlash(text, cp, {
          knownLocalNames: localNames.current,
          setNotice: (n) => cp.notify(n),
          openModelPicker: () => window.dispatchEvent(new Event("codepilot:open-model-picker")),
          openPanel: (name) => {
            if (name === "sessions") {
              window.dispatchEvent(new Event("codepilot:open-history"));
              return;
            }
            if (name === "help") {
              cp.notify(
                t(
                  "Commands: /model /sessions /mcp /skills /plugins /context /compact /clear /undo /redo /retry /schedule /goal /init /export /mode /preset /resume /hooks /agents /theme /gc-artifacts",
                ),
              );
              return;
            }
            if (name === "context") {
              const u = state.usage;
              cp.notify(
                u ? `Context: ${u.input} in / ${u.output} out` : t("No context usage yet."),
              );
              return;
            }
            // Capabilities → FeatureDialog; /plugins stays in Settings.
            if (name === "mcp") {
              window.dispatchEvent(
                new CustomEvent("codepilot:open-feature", { detail: { section: "connectors" } }),
              );
              return;
            }
            if (name === "custom-mcp") {
              window.dispatchEvent(
                new CustomEvent("codepilot:open-feature", { detail: { section: "custom-mcp" } }),
              );
              return;
            }
            if (name === "skills") {
              window.dispatchEvent(
                new CustomEvent("codepilot:open-feature", { detail: { section: "skills" } }),
              );
              return;
            }
            if (name === "schedule") {
              window.dispatchEvent(
                new CustomEvent("codepilot:open-feature", { detail: { section: "schedule" } }),
              );
              return;
            }
            const section =
              name === "plugins" ? "plugins" : name === "provider" ? "models" : "general";
            window.dispatchEvent(new CustomEvent("codepilot:open-settings", { detail: { section } }));
          },
        });
        if (outcome.handled) {
          if (outcome.notice) cp.notify(outcome.notice);
          if (outcome.forward && outcome.forward.trim()) {
            await cp.send(outcome.forward, images, files, delivery);
          }
          return;
        }
        // Expand markdown / MCP prompt slash commands before the model turn.
        const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        const cmdName = m?.[1]?.toLowerCase() ?? "";
        const cmdArgs = (m?.[2] ?? "").trim();
        const promptMeta = promptCommands.current?.get(cmdName);
        if (promptMeta) {
          if (promptMeta.argumentHint && !cmdArgs) {
            cp.notify(`Usage: /${cmdName} ${promptMeta.argumentHint}`);
            return;
          }
          try {
            const expanded = await cp.client.commandsExpand(cmdName, cmdArgs, state.cwd || undefined);
            await cp.send(expanded.prompt, images, files, delivery);
          } catch (err) {
            cp.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
      }
      await cp.send(text, images, files, delivery);
    },
    onStop: () => void cp.cancel(),
    busy,
    disabled: state.connection !== "connected",
    placeholder:
      state.connection !== "connected" ? t("Connect and open a session to start…") : placeholder,
    mode: state.agentMode,
    modes: cp.client.modes,
    onMode: (m: typeof state.agentMode) => void cp.setMode(m),
    followUps: state.followUps,
    pendingSteers: state.pendingSteers,
    onRemoveFollowUp: (id: string) => void cp.removeFollowUp(id),
    onEditFollowUp: (id: string) => {
      const fu = state.followUps?.find((x) => x.id === id);
      if (!fu) return;
      void cp.removeFollowUp(id);
      setDraft(fu.text);
    },
    onSendFollowUpNow: (id: string) => cp.sendFollowUpNow(id),
    menuProvider: {
      listCommands: async () => {
        try {
          const r = await cp.client.commandsList(state.cwd || undefined);
          return r.commands.filter((c) => !(c.kind === "local" && WEB_UNSUPPORTED_LOCAL.has(c.name)));
        } catch {
          return [];
        }
      },
      complete: async (query: string, kind: "file" | "dir" | "mcp" | "git" | "skill") => {
        try {
          const r = await cp.client.workspaceComplete(query, {
            kinds: [kind],
            cwd: state.cwd || undefined,
            maxResults: 40,
          });
          return { candidates: r.candidates, truncated: r.truncated };
        } catch {
          return { candidates: [] };
        }
      },
    },
    // Model chip sits by send; usage + context sit on a quieter status strip.
    footer: <ModelPicker cp={cp} />,
    statusBar:
      state.sessionId || state.usage.input > 0 || state.usage.output > 0 ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="min-w-0 flex-1 truncate">
            <UsageLine state={state} />
          </span>
          <span className="shrink-0">
            <ContextGauge client={cp.client} sessionId={state.sessionId} state={state} />
          </span>
        </span>
      ) : null,
  };
}
