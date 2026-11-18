import {
  killAllJobs,
  runUpdateCheck,
  exportSession,
  listSessions,
  type SessionExportFormat,
} from "@codepilot/core";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function cmdUpdate(
  flags: Record<string, string | boolean>,
): Promise<number> {
  const checkOnly = flags["check"] === true;
  const result = await runUpdateCheck({ checkOnly });
  if (!result) {
    process.stderr.write(
      "update: skipped (not a ~/.codepilot prefix install, or check failed / disabled)\n",
    );
    return 1;
  }
  if (!result.available && checkOnly) {
    process.stdout.write(`up to date: ${result.current}\n`);
    return 0;
  }
  if (checkOnly && result.available) {
    process.stdout.write(`update available: ${result.current} → ${result.latest}\n`);
    return 0;
  }
  process.stdout.write(`current: ${result.current}\n`);
  return 0;
}

export async function cmdExport(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const formatRaw = String(flags["format"] ?? "md").toLowerCase();
  const format: SessionExportFormat =
    formatRaw === "jsonl" || formatRaw === "json" ? "jsonl" : "markdown";
  let id = positional[0];
  if (!id) {
    const sessions = await listSessions();
    id = sessions[0]?.id;
    if (!id) {
      process.stderr.write("export: no sessions found\n");
      return 1;
    }
  }
  const body = await exportSession(id, format);
  const outFlag = flags["o"] ?? flags["out"] ?? flags["output"];
  if (typeof outFlag === "string" && outFlag) {
    const dest = resolve(outFlag);
    await writeFile(dest, body, "utf-8");
    process.stderr.write(`exported ${format} → ${dest}\n`);
    return 0;
  }
  process.stdout.write(body.endsWith("\n") ? body : body + "\n");
  return 0;
}

/**
 * Opt-in ACP (Agent Client Protocol) stdio server. Only runs when the `acp`
 * subcommand is invoked; blocks until the stream closes.
 */
export async function cmdAcp(
  flags: Record<string, string | boolean>,
): Promise<number> {
  const { startAcpServer } = await import("../acp.js");
  const handle = await startAcpServer({
    defaultCwd: (flags["cwd"] as string | undefined) ?? process.cwd(),
  });
  await handle.peer.loopDone;
  await handle.dispose().catch(() => {});
  await killAllJobs().catch(() => {});
  return 0;
}