/**
 * First-run setup guide (`/setup`, and auto-opened once on first launch).
 *
 * Walks the user through three optional steps:
 *   1. provider  — reuse the `/connect` flow to add a model (required to chat).
 *   2. search    — pick a web_search backend; keyed providers prompt for a key,
 *                  DuckDuckGo (default) / skip keep the keyless fallback.
 *   3. image_gen — paste a baseURL + key to enable image generation; skip
 *                  leaves it disabled.
 *
 * Nothing here is mandatory: every step can be skipped. When the guide closes
 * (completed OR skipped) the caller stamps `onboardedAt` so it never auto-opens
 * again. Search / image settings are persisted to the user config
 * (`~/.codepilot/config.json`) via readUserConfigFile / writeUserConfigFile.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import {
  readUserConfigFile,
  writeUserConfigFile,
  type WebSearchProvider,
} from "@codepilot/core";
import { color as palette } from "./theme.js";
import { isEscape } from "./keys.js";
import { ConnectWizard } from "./ConnectWizard.js";

export interface SetupWizardProps {
  /** Existing provider ids, forwarded to the embedded ConnectWizard. */
  existingIds: string[];
  /** True when at least one provider is already configured, so the provider
   * step can be offered as "skip (already connected)". */
  hasProvider: boolean;
  /** Called when the embedded provider step connects a provider, so the caller
   * can activate it (same handling as the standalone `/connect`). */
  onProviderConnected: (result: { id: string; model: string }) => void;
  /** Called when the whole guide finishes (completed or skipped). `summary`
   * lists the human-readable outcome lines to show as a notice. */
  onDone: (summary: string[]) => void;
}

type SearchChoice = {
  provider: WebSearchProvider;
  label: string;
  description: string;
  needsKey: boolean;
  envVar?: string;
  signupUrl?: string;
};

const SEARCH_CHOICES: readonly SearchChoice[] = [
  {
    provider: "duckduckgo",
    label: "DuckDuckGo (default, keyless)",
    description: "free, no key — best-effort quality",
    needsKey: false,
  },
  {
    provider: "brave",
    label: "Brave Search API",
    description: "2000/mo free · brave.com/search/api",
    needsKey: true,
    envVar: "BRAVE_API_KEY",
    signupUrl: "https://brave.com/search/api",
  },
  {
    provider: "serper",
    label: "Serper (Google results)",
    description: "2500 free · serper.dev",
    needsKey: true,
    envVar: "SERPER_API_KEY",
    signupUrl: "https://serper.dev",
  },
];

type Step =
  | { kind: "provider" }
  | { kind: "search-pick" }
  | { kind: "search-key"; choice: SearchChoice }
  | { kind: "image-ask" }
  | { kind: "image-base-url" }
  | { kind: "image-key"; baseURL: string }
  | { kind: "image-model"; baseURL: string; apiKey: string }
  | { kind: "saving" };

export function SetupWizard(props: SetupWizardProps): React.ReactElement {
  const { existingIds, hasProvider, onProviderConnected, onDone } = props;
  const [step, setStep] = React.useState<Step>({ kind: "provider" });
  const [error, setError] = React.useState<string | undefined>();
  const summary = React.useRef<string[]>([]);

  // Esc at any point skips the current step forward (never cancels the whole
  // guide destructively — skipping is a valid, expected outcome).
  const advance = React.useCallback((from: Step["kind"]) => {
    if (from === "provider") setStep({ kind: "search-pick" });
    else if (from === "search-pick" || from === "search-key")
      setStep({ kind: "image-ask" });
    else if (
      from === "image-ask" ||
      from === "image-base-url" ||
      from === "image-key" ||
      from === "image-model"
    ) {
      setStep({ kind: "saving" });
      onDone(summary.current.length ? summary.current : ["Setup skipped"]);
    }
  }, [onDone]);

  // ---- Step 1: provider (embed ConnectWizard) --------------------------
  if (step.kind === "provider") {
    return (
      <WizardFrame
        title="Setup · 1/3 provider"
        hint={hasProvider ? "Esc skip (already connected)" : "Esc skip"}
      >
        <Text dimColor>
          Connect a model provider (API key). You can skip and run /connect
          later.
        </Text>
        <ConnectWizard
          existingIds={existingIds}
          onDone={(result) => {
            if (result.cancelled || !result.id) {
              advance("provider");
              return;
            }
            onProviderConnected({ id: result.id, model: result.model });
            summary.current.push(`Provider → ${result.id} · ${result.model}`);
            setStep({ kind: "search-pick" });
          }}
        />
      </WizardFrame>
    );
  }

  // ---- Step 2: web search backend --------------------------------------
  if (step.kind === "search-pick") {
    return (
      <WizardFrame title="Setup · 2/3 web search" hint="Esc keep default">
        <Text dimColor>
          DuckDuckGo works with no key but quality is weak. Pick a stronger
          backend (needs a free key) or keep the default:
        </Text>
        <OptionList
          options={SEARCH_CHOICES.map((c) => ({
            label: c.label,
            description: c.description,
            value: c.provider,
          }))}
          onEscape={() => {
            summary.current.push("Search → DuckDuckGo (default)");
            advance("search-pick");
          }}
          onPick={(provider) => {
            const choice = SEARCH_CHOICES.find((c) => c.provider === provider)!;
            if (!choice.needsKey) {
              // DuckDuckGo: leave config untouched (auto-fallback already does
              // this). Just move on.
              summary.current.push("Search → DuckDuckGo (default)");
              setStep({ kind: "image-ask" });
              return;
            }
            setStep({ kind: "search-key", choice });
          }}
        />
      </WizardFrame>
    );
  }

  if (step.kind === "search-key") {
    const { choice } = step;
    return (
      <WizardFrame
        title={`Setup · 2/3 · ${choice.label}`}
        hint="Esc skip this backend"
      >
        {error && <Text color={palette.remove}>{error}</Text>}
        <Text dimColor>
          Get a free key at {choice.signupUrl}. Paste it below, or press Esc to
          keep DuckDuckGo. (You can also set {choice.envVar} in your shell
          instead.)
        </Text>
        <Text>API key:</Text>
        <FreeText
          mask
          placeholder="paste key…"
          onEscape={() => {
            summary.current.push("Search → DuckDuckGo (default)");
            advance("search-key");
          }}
          onSubmit={(apiKey) => {
            void (async () => {
              setError(undefined);
              setStep({ kind: "saving" });
              try {
                await patchUserConfig((raw) => {
                  raw.webSearch = {
                    ...(typeof raw.webSearch === "object" && raw.webSearch
                      ? (raw.webSearch as Record<string, unknown>)
                      : {}),
                    provider: choice.provider,
                    apiKey,
                  };
                });
                summary.current.push(`Search → ${choice.label}`);
                setStep({ kind: "image-ask" });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStep({ kind: "search-key", choice });
              }
            })();
          }}
        />
      </WizardFrame>
    );
  }

  // ---- Step 3: image generation ----------------------------------------
  if (step.kind === "image-ask") {
    return (
      <WizardFrame title="Setup · 3/3 image generation" hint="Esc skip (stays off)">
        <Text dimColor>
          Image generation is off by default. Enable it by pointing at an
          image-model endpoint (OpenAI-compatible). Skip to leave it disabled.
        </Text>
        <OptionList
          options={[
            { label: "Enable image generation", value: "enable" },
            { label: "Skip (keep disabled)", value: "skip" },
          ]}
          onEscape={() => {
            summary.current.push("Image generation → disabled");
            advance("image-ask");
          }}
          onPick={(v) => {
            if (v === "skip") {
              summary.current.push("Image generation → disabled");
              advance("image-ask");
              return;
            }
            setStep({ kind: "image-base-url" });
          }}
        />
      </WizardFrame>
    );
  }

  if (step.kind === "image-base-url") {
    return (
      <WizardFrame title="Setup · 3/3 · image endpoint" hint="Esc skip">
        <Text>Image API baseURL:</Text>
        <FreeText
          placeholder="https://api.openai.com/v1"
          onEscape={() => {
            summary.current.push("Image generation → disabled");
            advance("image-base-url");
          }}
          onSubmit={(baseURL) => setStep({ kind: "image-key", baseURL })}
        />
      </WizardFrame>
    );
  }

  if (step.kind === "image-key") {
    return (
      <WizardFrame title="Setup · 3/3 · image endpoint" hint="Esc skip">
        {error && <Text color={palette.remove}>{error}</Text>}
        <Text>Image API key:</Text>
        <FreeText
          mask
          placeholder="sk-…"
          onEscape={() => {
            summary.current.push("Image generation → disabled");
            advance("image-key");
          }}
          onSubmit={(apiKey) =>
            setStep({ kind: "image-model", baseURL: step.baseURL, apiKey })
          }
        />
      </WizardFrame>
    );
  }

  if (step.kind === "image-model") {
    const { baseURL, apiKey } = step;
    const saveImage = (model: string) => {
      void (async () => {
        setError(undefined);
        setStep({ kind: "saving" });
        try {
          await patchUserConfig((raw) => {
            raw.imageGen = {
              baseURL,
              apiKey,
              ...(model.trim() ? { model: model.trim() } : {}),
              enabled: true,
            };
          });
          summary.current.push("Image generation → enabled");
          onDone(summary.current);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setStep({ kind: "image-model", baseURL, apiKey });
        }
      })();
    };
    return (
      <WizardFrame
        title="Setup · 3/3 · image model"
        hint="Enter to accept default · Esc default"
      >
        {error && <Text color={palette.remove}>{error}</Text>}
        <Text dimColor>Model id (blank = gpt-image-1):</Text>
        <FreeText
          allowEmpty
          placeholder="gpt-image-1"
          onEscape={() => saveImage("")}
          onSubmit={saveImage}
        />
      </WizardFrame>
    );
  }

  return (
    <WizardFrame title="Setup">
      <Text dimColor>Saving…</Text>
    </WizardFrame>
  );
}

/** Read-modify-write the user config file, applying `mutate` to the raw object. */
async function patchUserConfig(
  mutate: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const { raw } = await readUserConfigFile();
  mutate(raw);
  await writeUserConfigFile(raw);
}

function WizardFrame({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Box>
        <Text bold color={palette.accent}>
          /setup{" "}
        </Text>
        <Text bold>{title}</Text>
        {hint ? (
          <>
            <Box flexGrow={1} />
            <Text dimColor>{hint}</Text>
          </>
        ) : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

function OptionList({
  options,
  onPick,
  onEscape,
}: {
  options: Array<{ label: string; description?: string; value: string }>;
  onPick(value: string): void;
  onEscape?(): void;
}): React.ReactElement {
  const [cursor, setCursor] = React.useState(0);
  useInput((input, key) => {
    if (isEscape(input, key)) {
      onEscape?.();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow) setCursor((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow) setCursor((i) => (i + 1) % options.length);
    else if (key.return) {
      const opt = options[Math.min(cursor, options.length - 1)];
      if (opt) onPick(opt.value);
    } else {
      const n = Number.parseInt(input, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length && String(n) === input) {
        onPick(options[n - 1]!.value);
      }
    }
  });
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt.value} inverse={i === cursor}>
          {i === cursor ? "▶ " : "  "}
          {i + 1}. {opt.label}
          {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function FreeText({
  onSubmit,
  placeholder,
  mask,
  allowEmpty,
  onEscape,
}: {
  onSubmit(text: string): void;
  placeholder?: string;
  mask?: boolean;
  allowEmpty?: boolean;
  onEscape?(): void;
}): React.ReactElement {
  const [value, setValue] = React.useState("");
  useInput((input, key) => {
    if (isEscape(input, key)) {
      onEscape?.();
      return;
    }
    if (key.return) {
      const text = value.trim();
      if (!text && !allowEmpty) return;
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      if (value.length > 0) setValue(value.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) setValue(value + input);
  });
  const shown = mask ? "•".repeat(value.length) : value;
  return (
    <Text>
      › {shown.length === 0 ? <Text dimColor>{placeholder ?? ""}</Text> : shown}
    </Text>
  );
}
