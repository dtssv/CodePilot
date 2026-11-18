import type { ConfigProviderRedacted } from "../../protocol/client.js";
import type { SettingsExtraSection } from "./types.js";

export type SettingsNav = "models" | SettingsExtraSection;

export type EngineUpdateRow = {
  current: string;
  latest: string | null;
  available: boolean;
  canAutoApply: boolean;
};

export type ProviderKind = "anthropic" | "openai" | "copilot" | "gemini" | "azure";

/** UI wire-protocol selector (maps onto provider + apiStyle). */
export type WireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "copilot"
  | "azure";

export type HeaderRow = { key: string; value: string };

/** A saved endpoint row (one providers-map entry — not bound 1:1 to a vendor). */
export type EndpointRow = {
  id: string;
  displayName: string;
  provider: ProviderKind;
  baseURL?: string;
  saved: ConfigProviderRedacted;
 /** Template id this was spawned from, if any (for UI hints only). */
  fromTemplate?: string;
};

export type DraftMode =
  | { kind: "edit"; id: string }
  | {
      kind: "add";
 /** Suggested providers-map id (editable). */
      id: string;
      provider: ProviderKind;
      displayName: string;
      baseURL: string;
 /** Built-in vendors hide baseURL; custom / ollama show it. */
      showBaseURL: boolean;
      fromTemplate?: string;
    };