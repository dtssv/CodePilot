import type { ThemeName } from "../../surface.js";

export const PAGE_SIZE = 24;
export type ListTab = "all" | "installed";

/** Display labels for the named palettes (i18n keys). */
export const THEME_NAME_LABELS: Record<ThemeName, string> = {
  default: "Default",
  nord: "Nord",
  solarized: "Solarized",
  "high-contrast": "High contrast",
};

export type SettingsExtraSection =
  | "connectors"
  | "custom-mcp"
  | "plugins"
  | "skills"
  | "remote"
  | "schedule"
  | "general";

export type ConnectorStatus = {
  id: string;
  installed: boolean;
  enabled: boolean;
  mcpName?: string;
  skillName?: string;
  skillInstalled?: boolean;
};

export type Connector = {
  id: string;
  name: string;
  description: string;
  category: string;
  credentials: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
  }>;
  securityNotice: string;
  docsUrl?: string;
  authUrl?: string;
  status: ConnectorStatus;
};

export type ManagedSkill = {
  name: string;
  description: string;
  state: "installed" | "available";
  enabled: boolean;
  source?: string;
  connectorId?: string;
  when?: string;
};

export type Task = {
  id: string;
  title: string;
  prompt?: string;
  kind: string;
  enabled: boolean;
  lastStatus?: string;
  lastRunAt?: number;
  lastError?: string;
  idleAfterMs?: number;
  at?: string;
  daysOfWeek?: number[];
  cron?: string;
  timezone?: string;
  runAt?: number;
  everyMinutes?: number;
  delivery?: "new_session" | { sessionId: string };
  paused?: boolean;
  endsAt?: number;
  runCount?: number;
  model?: string;
  providerId?: string;
  agentMode?: "chat" | "plan" | "agent";
};

export type ScheduleModelOpt = {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
};