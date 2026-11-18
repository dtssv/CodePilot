import { loadConfig as coreLoadConfig, type CodepilotConfig } from "@codepilot/core";

export async function loadConfigSafe(cwd: string): Promise<CodepilotConfig | undefined> {
  try {
    return await coreLoadConfig(cwd);
  } catch {
    return undefined;
  }
}