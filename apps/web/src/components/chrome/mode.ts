import type { AgentMode } from "@codepilot/core";

import { t } from "../../i18n.js";

export function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case "chat":
      return t("Ask");
    case "plan":
      return t("Plan");
    case "agent":
      return t("Agent");
  }
}

export function modeHint(mode: AgentMode): string {
  switch (mode) {
    case "chat":
      return t("Read-only Q&A");
    case "plan":
      return t("Explore and write a plan, no changes");
    case "agent":
      return t("Edit files and run commands");
  }
}