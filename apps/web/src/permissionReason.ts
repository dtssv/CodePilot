/**
 * Localize engine permission-reason strings (core emits English templates;
 * the web UI translates known fragments).
 */
import { t } from "./i18n.js";

/** Longer / more specific fragments first. */
const FRAGMENTS: string[] = [
  " SANDBOX ESCALATION: this command will run WITHOUT the OS sandbox (full host access for this one command).",
  "Write path is outside the sandbox writable roots. Allow once adds “",
  "” for this session; Always allow also saves it to sandbox.writablePaths. ",
  " GIT METADATA: writing under ",
  " can corrupt history or plant a hook; use `git` subcommands instead.",
  " SENSITIVE PATH: writing under ",
  " (system/credential location).",
  " DANGEROUS: ",
  " Reason: ",
  "Stop a background shell job (SIGTERM).",
  "Send input to a background shell job's stdin.",
  "memory_write (scope=user, cross-repo): durable note will apply in other projects too.",
  "memory_write (scope=project): durable note for this project only.",
];

const TEMPLATES: Array<{ re: RegExp; fill: (m: RegExpMatchArray) => string }> = [
  {
    re: /^Tool (.+?) will execute a shell command\./,
    fill: (m) =>
      t("Tool $TOOL will execute a shell command.").replaceAll("$TOOL", m[1]!),
  },
  {
    re: /^Tool (.+?) will modify files\./,
    fill: (m) => t("Tool $TOOL will modify files.").replaceAll("$TOOL", m[1]!),
  },
  {
    re: /^Tool (.+?) will access the network\./,
    fill: (m) => t("Tool $TOOL will access the network.").replaceAll("$TOOL", m[1]!),
  },
  {
    re: /^Tool (.+?) requires permission\./,
    fill: (m) => t("Tool $TOOL requires permission.").replaceAll("$TOOL", m[1]!),
  },
  {
    re: /^Read-only tool \((.+?)\)/,
    fill: (m) => t("Read-only tool ($TOOL)").replaceAll("$TOOL", m[1]!),
  },
  {
    re: /^Apply patch to (\d+) file\(s\):\n/,
    fill: (m) => `${t("Apply patch to $N file(s):").replaceAll("$N", m[1]!)}\n`,
  },
];

export function localizePermissionReason(reason: string): string {
  if (!reason) return reason;
  let out = reason;
  for (const { re, fill } of TEMPLATES) {
    const m = out.match(re);
    if (!m) continue;
    out = out.replace(re, fill(m));
    break;
  }
  for (const en of FRAGMENTS) {
    if (out.includes(en)) out = out.split(en).join(t(en));
  }
  return out;
}
