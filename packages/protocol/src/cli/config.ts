import {
  loadConfigWithSources,
  listSelectableModels,
  resolveModelTarget,
  templateToPreset,
  listProviderTemplates,
  redactApiKey,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  type ProviderPreset,
  type ResolvedCodepilotConfig,
} from "@codepilot/core";
import { resolve } from "node:path";

function configHelp(): string {
  return `codepilot config — manage user providers (~/.codepilot/config.json)

Usage:
  codepilot config show
  codepilot config providers
  codepilot config templates
  codepilot config add <id> --provider openai|anthropic|copilot
                          [--base-url URL] [--api-key KEY] [--model M]
                          [--small-model M] [--models m1,m2] [--display-name N]
                          [--from-template TEMPLATE_ID] [--use]
  codepilot config remove <id>
  codepilot config use <id> [--model M]
`;
}

export async function cmdConfig(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const sub = positional[0] ?? "show";
  const cwd = typeof flags["cwd"] === "string" ? resolve(flags["cwd"]) : process.cwd();

  switch (sub) {
    case "help":
    case "--help":
      process.stdout.write(configHelp() + "\n");
      return 0;
    case "show": {
      const { config, sources } = await loadConfigWithSources(cwd);
      const { hasApiKey, apiKeyHint } = redactApiKey(config.apiKey);
      const out = {
        active: {
          provider: config.provider,
          model: config.model,
          smallModel: config.smallModel,
          baseURL: config.baseURL,
          hasApiKey,
          apiKeyHint,
          activeProvider: (config as ResolvedCodepilotConfig & { activeProvider?: string })
            .activeProvider,
        },
        providers: Object.fromEntries(
          Object.entries(config.providers ?? {}).map(([id, p]) => {
            const red = redactApiKey(p.apiKey);
            return [
              id,
              {
                ...p,
                apiKey: undefined,
                hasApiKey: red.hasApiKey,
                apiKeyHint: red.apiKeyHint,
              },
            ];
          }),
        ),
        selectableModels: listSelectableModels(config),
        sources: sources.map((s) => ({ name: s.name, source: s.source })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return 0;
    }
    case "providers": {
      const { config } = await loadConfigWithSources(cwd);
      const providers = config.providers ?? {};
      if (Object.keys(providers).length === 0) {
        process.stdout.write("(no providers configured — try `codepilot config templates`)\n");
        return 0;
      }
      for (const [id, p] of Object.entries(providers)) {
        const red = redactApiKey(p.apiKey);
        const key = red.hasApiKey ? ` key=···${red.apiKeyHint}` : " key=-";
        process.stdout.write(
          `${id}\t${p.provider}\t${p.displayName ?? ""}\tmodel=${p.model ?? "-"}${key}` +
            (p.baseURL ? `\t${p.baseURL}` : "") +
            "\n",
        );
      }
      return 0;
    }
    case "templates": {
      const templates = await listProviderTemplates();
      for (const t of templates) {
        process.stdout.write(
          `${t.id}\t${t.displayName}\t${t.provider}` +
            (t.baseURL ? `\t${t.baseURL}` : "") +
            (t.models?.length ? `\t[${t.models.join(", ")}]` : "") +
            (t.description ? `\t${t.description}` : "") +
            "\n",
        );
      }
      return 0;
    }
    case "add": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config add <id> [...flags]\n");
        return 2;
      }
      let preset: ProviderPreset;
      const fromTemplate =
        typeof flags["from-template"] === "string" ? flags["from-template"] : undefined;
      if (fromTemplate) {
        const tmpl = (await listProviderTemplates()).find((t) => t.id === fromTemplate);
        if (!tmpl) {
          process.stderr.write(`unknown template: ${fromTemplate}\n`);
          return 2;
        }
        preset = templateToPreset(tmpl);
      } else {
        const provider = flags["provider"];
        if (provider !== "openai" && provider !== "anthropic" && provider !== "copilot") {
          process.stderr.write(
            "config add requires --provider openai|anthropic|copilot (or --from-template)\n",
          );
          return 2;
        }
        preset = { provider };
      }
      if (typeof flags["base-url"] === "string") preset.baseURL = flags["base-url"];
      if (typeof flags["api-key"] === "string") preset.apiKey = flags["api-key"];
      if (typeof flags["model"] === "string") preset.model = flags["model"];
      if (typeof flags["small-model"] === "string") preset.smallModel = flags["small-model"];
      if (typeof flags["display-name"] === "string") preset.displayName = flags["display-name"];
      if (typeof flags["models"] === "string") {
        preset.models = flags["models"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (!preset.displayName) preset.displayName = id;
      await upsertUserProvider(id, preset);
      if (flags["use"] === true) {
        await setUserActiveEndpoint({
          providerId: id,
          provider: preset.provider,
          model: preset.model,
          smallModel: preset.smallModel,
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
        });
      }
      process.stdout.write(`ok: provider "${id}" saved${flags["use"] === true ? " (active)" : ""}\n`);
      return 0;
    }
    case "remove":
    case "rm":
    case "delete": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config remove <id>\n");
        return 2;
      }
      await deleteUserProvider(id);
      process.stdout.write(`ok: provider "${id}" removed\n`);
      return 0;
    }
    case "use": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config use <id> [--model M]\n");
        return 2;
      }
      const { config } = await loadConfigWithSources(cwd);
      let preset = config.providers?.[id];
      if (!preset) {
        const tmpl = (await listProviderTemplates()).find((t) => t.id === id);
        if (!tmpl) {
          process.stderr.write(`unknown provider: ${id}\n`);
          return 2;
        }
        preset = templateToPreset(tmpl);
        await upsertUserProvider(id, preset);
      }
      const model =
        (typeof flags["model"] === "string" ? flags["model"] : undefined) ??
        preset.model;
      await setUserActiveEndpoint({
        providerId: id,
        provider: preset.provider,
        model,
        smallModel: preset.smallModel,
        baseURL: preset.baseURL,
        apiKey: preset.apiKey,
      });
      process.stdout.write(`ok: active → ${id}${model ? ` · ${model}` : ""}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown config subcommand: ${sub}\n\n${configHelp()}`);
      return 2;
  }
}