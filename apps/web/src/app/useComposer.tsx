import { useRef } from "react";
import type { ImageAttachment, PromptFile } from "@codepilot/core";
import { UsageLine } from "../components/Chrome.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { ContextGauge } from "../components/ContextGauge.js";
import { interpretSlash } from "../state/slashCommands.js";
import type { Codepilot } from "../state/useCodepilot.js";
import { t } from "../i18n.js";

export function useComposer(cp: Codepilot, draft: string, setDraft: (v: string) => void, placeholder?: string) {
  const { state } = cp;
  const busy = state.status !== "idle";
  // Cache of known LOCAL command names (kind === "local") from the commands/list
  // RPC, so a local command this surface can't run is reported as unsupported
  // instead of leaking to the model. Fetched lazily on first slash use.
  const localNames = useRef<ReadonlySet<string> | null>(null);
  return {
    value: draft,
    onChange: setDraft,
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
        if (!localNames.current) {
          try {
            const r = await cp.client.commandsList(state.cwd || undefined);
            localNames.current = new Set(r.commands.filter((c) => c.kind === "local").map((c) => c.name));
          } catch {
            localNames.current = new Set();
          }
        }
        const outcome = await interpretSlash(text, cp, { knownLocalNames: localNames.current });
        if (outcome.handled) {
          if (outcome.forward && outcome.forward.trim()) {
            await cp.send(outcome.forward, images, files, delivery);
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
          return r.commands;
        } catch {
          return [];
        }
      },
      complete: async (query: string, kind: "file" | "dir" | "mcp" | "git" | "skill") => {
        try {
          const r = await cp.client.workspaceComplete(query, { kinds: [kind], cwd: state.cwd || undefined });
          return r.candidates;
        } catch {
          return [];
        }
      },
    },
    footer: (
      // Single no-wrap row: the model name (truncatable) takes the slack, the
      // context gauge stays fixed and always visible, and the cumulative-usage
      // line is the first to hide when the composer is narrow (e.g. the files
      // panel is open) — it's the least important and its big number read as
      // "deformation" when it wrapped under the gauge.
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <span className="flex min-w-0 shrink items-center overflow-hidden">
          <ModelPicker cp={cp} />
        </span>
        <span className="shrink-0">
          <ContextGauge client={cp.client} sessionId={state.sessionId} state={state} />
        </span>
        <span className="hidden shrink-0 min-[560px]:inline-flex">
          <UsageLine state={state} />
        </span>
      </span>
    ),
  };
}
