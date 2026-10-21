/**
 * Interactive `/connect` flow: pick a vendor template,
 * enter key (+ baseURL for custom), optionally fetch models, save preset.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import {
  PROVIDER_TEMPLATES,
  listRemoteModels,
  nextProviderId,
  resolveModelCapabilities,
  upsertUserProvider,
  setUserActiveEndpoint,
  type ProviderPreset,
  type ProviderTemplate,
  type RemoteModelInfo,
} from "@codepilot/core";
import { color as palette } from "./theme.js";

export interface ConnectWizardProps {
 /** Existing providers-map ids (for unique id allocation). */
  existingIds: string[];
  onDone: (result: { id: string; model: string; cancelled?: boolean }) => void;
}

type Step =
  | { kind: "pick-vendor" }
  | { kind: "base-url"; template: ProviderTemplate; id: string }
  | { kind: "api-key"; template: ProviderTemplate; id: string; baseURL?: string }
  | {
      kind: "models";
      template: ProviderTemplate;
      id: string;
      baseURL?: string;
      apiKey: string;
      remote: RemoteModelInfo[];
    }
  | { kind: "saving" };

export function ConnectWizard(props: ConnectWizardProps): React.ReactElement {
  const { existingIds, onDone } = props;
  const [step, setStep] = React.useState<Step>({ kind: "pick-vendor" });
  const [error, setError] = React.useState<string | undefined>();

  useInput((_input, key) => {
    if (key.escape) onDone({ id: "", model: "", cancelled: true });
  });

  const vendors = [...PROVIDER_TEMPLATES];

  if (step.kind === "pick-vendor") {
    return (
      <WizardFrame title="Connect provider" hint="Esc cancel">
        <Text dimColor>Select a vendor (or custom OpenAI / Claude protocol):</Text>
        <OptionList
          options={vendors.map((t) => ({
            label: t.displayName,
            description: t.requiresBaseURL
              ? "needs baseURL"
              : t.description ?? t.provider,
            value: t.id,
          }))}
          onPick={(id) => {
            const template = vendors.find((t) => t.id === id)!;
            const endpointId = nextProviderId(template.id, existingIds);
            if (template.requiresBaseURL) {
              setStep({ kind: "base-url", template, id: endpointId });
            } else {
              setStep({
                kind: "api-key",
                template,
                id: endpointId,
                baseURL: template.baseURL,
              });
            }
          }}
        />
      </WizardFrame>
    );
  }

  if (step.kind === "base-url") {
    return (
      <WizardFrame title={`Connect · ${step.template.displayName}`} hint="Esc cancel">
        <Text>baseURL (required for custom gateways):</Text>
        <FreeText
          placeholder="https://api.example.com/v1"
          onSubmit={(baseURL) => {
            setStep({
              kind: "api-key",
              template: step.template,
              id: step.id,
              baseURL,
            });
          }}
        />
      </WizardFrame>
    );
  }

  if (step.kind === "api-key") {
    return (
      <WizardFrame title={`Connect · ${step.template.displayName}`} hint="Esc cancel">
        {error && <Text color={palette.remove}>{error}</Text>}
        <Text>API key:</Text>
        <FreeText
          mask
          placeholder="sk-…"
          onSubmit={(apiKey) => {
            void (async () => {
              setError(undefined);
              try {
                const remote = await listRemoteModels({
                  provider: step.template.provider,
                  baseURL: step.baseURL,
                  apiKey,
                });
                if (remote.length === 0) {
 // Save with template defaults / empty models list.
                  const model = step.template.models?.[0] ?? "default";
                  await savePreset(step.id, step.template, step.baseURL, apiKey, [
                    model,
                  ]);
                  onDone({ id: step.id, model });
                  return;
                }
                setStep({
                  kind: "models",
                  template: step.template,
                  id: step.id,
                  baseURL: step.baseURL,
                  apiKey,
                  remote,
                });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
        />
        <Text dimColor>Enter to fetch models · Esc cancel</Text>
      </WizardFrame>
    );
  }

  if (step.kind === "models") {
    const options = step.remote.slice(0, 40).map((m) => {
      const bits = [
        m.contextWindowMax
          ? m.contextWindowMax >= 1000
            ? `${Math.round(m.contextWindowMax / 1000)}k`
            : String(m.contextWindowMax)
          : undefined,
        m.modalities?.join("+"),
      ].filter(Boolean);
      return {
        label: bits.length ? `${m.id} (${bits.join(", ")})` : m.id,
        value: m.id,
      };
    });
    return (
      <WizardFrame title={`Connect · ${step.template.displayName}`} hint="Space toggle · Enter save">
        {error && <Text color={palette.remove}>{error}</Text>}
        <Text>Enable models (at least one):</Text>
        <MultiPick
          options={options}
          onPick={async (picked) => {
            if (picked.length === 0) {
              setError("Select at least one model");
              return;
            }
            setStep({ kind: "saving" });
            try {
              await savePreset(
                step.id,
                step.template,
                step.baseURL,
                step.apiKey,
                picked,
                step.remote,
              );
              onDone({ id: step.id, model: picked[0]! });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setStep(step);
            }
          }}
        />
      </WizardFrame>
    );
  }

  return (
    <WizardFrame title="Connect provider">
      <Text dimColor>Saving…</Text>
    </WizardFrame>
  );
}

async function savePreset(
  id: string,
  template: ProviderTemplate,
  baseURL: string | undefined,
  apiKey: string,
  models: string[],
  remote: RemoteModelInfo[] = [],
): Promise<void> {
  const modelCapabilities: NonNullable<ProviderPreset["modelCapabilities"]> = {};
  for (const modelId of models) {
    const info = remote.find((r) => r.id === modelId);
    modelCapabilities[modelId] = resolveModelCapabilities(modelId, info);
  }
  const preset: ProviderPreset = {
    provider: template.provider,
    displayName: template.displayName,
    baseURL: baseURL ?? template.baseURL,
    apiKey,
    model: models[0],
    smallModel: template.smallModel,
    models,
    modelCapabilities,
  };
  await upsertUserProvider(id, preset);
  const primary = models[0]!;
  await setUserActiveEndpoint({
    providerId: id,
    provider: preset.provider,
    model: preset.model,
    smallModel: preset.smallModel,
    baseURL: preset.baseURL,
    apiKey: preset.apiKey,
    contextWindow: modelCapabilities[primary]?.contextWindow,
  });
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
          /connect{" "}
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
}: {
  options: Array<{ label: string; description?: string; value: string }>;
  onPick(value: string): void;
}): React.ReactElement {
  const [cursor, setCursor] = React.useState(0);
  useInput((input, key) => {
    if (key.upArrow) setCursor((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow) setCursor((i) => (i + 1) % options.length);
    else if (key.return) onPick(options[cursor]!.value);
    else {
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

function MultiPick({
  options,
  onPick,
}: {
  options: Array<{ label: string; value: string }>;
  onPick(values: string[]): void | Promise<void>;
}): React.ReactElement {
  const [cursor, setCursor] = React.useState(0);
  const [checked, setChecked] = React.useState<Set<number>>(() => new Set([0]));
  useInput((input, key) => {
    if (key.upArrow) setCursor((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow) setCursor((i) => (i + 1) % options.length);
    else if (input === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
    } else if (key.return) {
      void onPick(
        options.filter((_, i) => checked.has(i)).map((o) => o.value),
      );
    }
  });
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt.value} inverse={i === cursor}>
          {i === cursor ? "▶ " : "  "}
          {checked.has(i) ? "[x] " : "[ ] "}
          {opt.label}
        </Text>
      ))}
    </Box>
  );
}

function FreeText({
  onSubmit,
  placeholder,
  mask,
}: {
  onSubmit(text: string): void;
  placeholder?: string;
  mask?: boolean;
}): React.ReactElement {
  const [value, setValue] = React.useState("");
  useInput((input, key) => {
    if (key.return) {
      const text = value.trim();
      if (!text) return;
      onSubmit(text);
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
