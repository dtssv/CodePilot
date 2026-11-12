// Built-in Stop verification — validity gate at the completion boundary.
// Built-in Stop gate: an optional post-completion check before the turn ends.
// Modes (config `stopVerify`): "off" (default), "prompt" (small-model judge),
// "tests" (run a detected project test command), true (alias for "prompt"),
// or { mode, forceContinue }. Default is "off" because the judge shares the
// provider's TPM budget and often 429s after a long task. Even when enabled,
// the verdict is advisory by default; `forceContinue: true` opts into the
// block→continue gate.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Event } from "./types.js";
import type { PreHookResult } from "./hooks.js";
import type { HookResolvers } from "./hooks-handlers.js";
import { isTransientError } from "./transientError.js";

export type StopVerifyMode = "off" | "prompt" | "tests";

/** Config shape for the built-in Stop gate (object form). */
export interface StopVerifyObject {
  mode: StopVerifyMode;
  /** When true, a negative result blocks and re-runs the turn (bounded by the
   * continue cap). When false/unset the result is advisory: a non-blocking
   * notice is surfaced and the turn still ends. */
  forceContinue?: boolean;
}

export type StopVerifyConfig = boolean | StopVerifyMode | StopVerifyObject;

export function resolveStopVerifyMode(
  value: StopVerifyConfig | undefined,
): StopVerifyMode {
  if (value && typeof value === "object") return value.mode;
  if (value === true || value === "prompt") return "prompt";
  if (value === "tests") return "tests";
  // false | "off" | undefined → off (no closing judge request)
  return "off";
}

/** Whether a negative built-in verdict should force a continue (re-run the
 * turn) rather than stay advisory. Only the object form can turn this on; the
 * string/boolean forms are always advisory. Default false. */
export function resolveStopVerifyForceContinue(
  value: StopVerifyConfig | undefined,
): boolean {
  return !!(value && typeof value === "object" && value.forceContinue === true);
}

/**
 * Decide the effective stopVerify mode for a completed turn.
 *
 * stopVerify is strictly opt-in: it runs only when the user explicitly sets a
 * mode ("prompt"/"tests"/true), and stays off otherwise. There is no automatic
 * "the turn touched a .ts file, so run the project tests" upgrade — that forced
 * a completion gate onto turns the user never asked to verify (including pure
 * analysis turns that merely edited a string in a source file), and when the
 * detected test command could not run in the hook's environment it looped,
 * re-summarising each round until the continue cap. Verification is the model's
 * own judgement (see the system prompt) or a user-configured Stop hook, not a
 * gate the framework imposes by file extension.
 */
export function effectiveStopVerifyMode(args: {
  /** Raw config value; an explicit `false`/"off" is honoured as off, same as unset. */
  configured: StopVerifyConfig | undefined;
}): StopVerifyMode {
  return resolveStopVerifyMode(args.configured);
}

export interface StopVerifyContext {
  cwd: string;
  reason: string;
  stop_hook_active: boolean;
  stop_continue_count: number;
  stop_continue_cap: number;
  session_id: string;
  /** Last assistant text + recent tool names, for the prompt judge. */
  transcript_hint: string;
  resolvers: HookResolvers;
}

/** Snapshot of the end of the transcript for the judge (bounded). */
export function buildStopTranscriptHint(events: Event[], maxChars = 6_000): string {
  const parts: string[] = [];
  const tools: string[] = [];
  for (let i = events.length - 1; i >= 0 && parts.join("\n").length < maxChars; i--) {
    const e = events[i]!;
    if (e.type === "tool_call") {
      tools.push(e.name);
    } else if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim()) parts.unshift(`assistant: ${text.trim().slice(-2_500)}`);
    } else if (e.type === "message" && e.role === "user") {
      const text = e.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim() && !text.includes("<stop_hook_continue")) {
        parts.unshift(`user: ${text.trim().slice(-1_500)}`);
        break; // stop at the originating user turn
      }
    } else if (e.type === "plan") {
      parts.unshift(
        `plan: ${e.steps.map((s) => `[${s.status}] ${s.title}`).join("; ")}`,
      );
    }
  }
  if (tools.length > 0) {
    parts.push(`recent_tools: ${[...new Set(tools.slice(0, 24))].join(", ")}`);
  }
  return parts.join("\n\n").slice(-maxChars);
}

const PROMPT_JUDGE = `You are a completion gate for a coding agent (Stop hook).
Decide whether the agent may END this turn. Judge only from evidence in the
conversation — tool results, command output, file contents. The agent claiming
it is done is not evidence. Do not assume any particular verification method,
tool, framework, or runtime; the right check is whatever the task and project
call for.

Block when ANY of these are true:
- The task has a deliverable whose behaviour was claimed to work, but nothing in the transcript exercised that behaviour — only structure checks (parse/typecheck/lint) were run, with no evidence of the result being exercised the way the task calls for.
- Stated acceptance criteria look unmet, or verification was skipped without saying why it was impossible.
- stop_hook_active is true AND the prior block reason was not addressed in the latest assistant work.

Allow when:
- The evidence shown matches the claim (the check that fits the task was run and its outcome is visible), OR the agent clearly stated verification was impossible and why.
- The change is a narrow fix with an appropriate automated check, or a Q&A/planning turn with no deliverable to verify.
- stop_hook_active is true and the agent fixed the prior concern.

De-escalation: you have already blocked this turn stop_continue_count time(s)
out of a cap of stop_continue_cap. Each block costs the user another full model
turn, so raise your bar for blocking as the count approaches the cap: block only
on a concrete, actionable gap you have NOT already raised. If the same concern
keeps recurring and the agent is clearly trying but cannot close it, allow and
let the agent report the limitation to the user rather than spinning to the cap.

Respond with JSON only — no markdown:
{"decision":"allow"}
or
{"decision":"block","reason":"one short sentence the agent should act on"}`;

/** Prefix stamped on the advisory warning carrying the built-in verifier's
 * concern when `forceContinue` is off. The session surfaces these as
 * non-blocking notices (they do not re-run the turn). */
export const STOP_VERIFY_ADVICE_PREFIX = "stopVerify advice: ";

/** Run the built-in Stop verifier for the configured mode. When `forceContinue`
 * is false (the default), a negative verdict is downgraded from a `block` to an
 * `allow` carrying the concern as an advisory warning, so the turn still ends
 * and the model/user simply see the note. When true, a negative verdict blocks
 * and the session re-runs the turn (bounded by the continue cap). */
export async function runBuiltinStopVerify(
  mode: StopVerifyMode,
  ctx: StopVerifyContext,
  opts: { forceContinue?: boolean } = {},
): Promise<PreHookResult> {
  if (mode === "off") return { action: "allow", warnings: [] };
  const raw = mode === "tests" ? await runTestsVerify(ctx) : await runPromptVerify(ctx);
  if (raw.action === "block" && opts.forceContinue !== true) {
    // Advise, don't gate: keep the concern but let the turn end.
    return {
      action: "allow",
      warnings: [
        ...raw.warnings,
        `${STOP_VERIFY_ADVICE_PREFIX}${raw.reason ?? "verification looked incomplete"}`,
      ],
    };
  }
  return raw;
}

async function runPromptVerify(ctx: StopVerifyContext): Promise<PreHookResult> {
  const resolver = ctx.resolvers.prompt;
  if (!resolver) {
    // Soft skip — no UI noise when the small-model path is unavailable.
    return { action: "allow", warnings: [] };
  }
  // Avoid unresolvable loops: after several continues, bias toward allow
  // unless the judge is very sure (handled by cap in session anyway).
  const payload = {
    reason: ctx.reason,
    stop_hook_active: ctx.stop_hook_active,
    stop_continue_count: ctx.stop_continue_count,
    stop_continue_cap: ctx.stop_continue_cap,
    session_id: ctx.session_id,
    transcript_hint: ctx.transcript_hint,
  };
  try {
    const raw = await resolver(PROMPT_JUDGE, payload);
    const decision = parseJudgeJson(raw);
    if (decision.action === "block") {
      return {
        action: "block",
        reason: decision.reason ?? "Built-in Stop verify: feature verification insufficient",
        warnings: [],
      };
    }
    return { action: "allow", warnings: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail open always. Rate-limit / overloaded judge calls are expected under
    // heavy sessions — do not surface them as transcript errors (they look like
    // the task failed after it already finished).
    if (isTransientJudgeFailure(message)) {
      return { action: "allow", warnings: [] };
    }
    return {
      action: "allow",
      warnings: [`stopVerify=prompt failed: ${message}`],
    };
  }
}

/** 429 / TPM / gateway overload / network blip — not a real "task failed"
 * signal. Delegates to the shared transient classifier so the judge path uses
 * the same policy as the agent loop and task retries (it formerly carried its
 * own regex that caught the TPM phrasings but missed network/timeout). */
export function isTransientJudgeFailure(message: string): boolean {
  return isTransientError(message);
}

function parseJudgeJson(raw: string): { action: "allow" | "block"; reason?: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "allow" };
  try {
    const json = JSON.parse(raw.slice(start, end + 1)) as {
      decision?: string;
      reason?: string;
    };
    if (json.decision === "block") {
      return { action: "block", reason: json.reason };
    }
  } catch {
    /* allow on parse failure — fail open for the built-in */
  }
  return { action: "allow" };
}

async function runTestsVerify(ctx: StopVerifyContext): Promise<PreHookResult> {
  const cmd = await detectTestCommand(ctx.cwd);
  if (!cmd) {
    return { action: "allow", warnings: [] };
  }
  const result = await runCommand(cmd.command, cmd.args, ctx.cwd, 120_000);
  if (result.code === 0) {
    return { action: "allow", warnings: [] };
  }
  const tail = (result.stderr || result.stdout).trim().slice(-1_200);
  return {
    action: "block",
    reason:
      `Built-in Stop verify: \`${cmd.display}\` failed (exit ${result.code}).` +
      (tail ? `\n${tail}` : ""),
    warnings: [],
  };
}

interface DetectedTest {
  command: string;
  args: string[];
  display: string;
}

async function detectTestCommand(cwd: string): Promise<DetectedTest | null> {
  const pkgPath = join(cwd, "package.json");
  try {
    await access(pkgPath);
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const scripts = pkg.scripts ?? {};
    const script =
      scripts["test:unit"] ??
      scripts["test"] ??
      scripts["check"] ??
      undefined;
    if (script && script !== 'echo "Error: no test specified" && exit 1') {
      const pm = pkg.packageManager?.startsWith("pnpm")
        ? "pnpm"
        : pkg.packageManager?.startsWith("yarn")
          ? "yarn"
          : (await exists(join(cwd, "pnpm-lock.yaml")))
            ? "pnpm"
            : (await exists(join(cwd, "yarn.lock")))
              ? "yarn"
              : "npm";
      const runArgs = pm === "npm" ? ["test", "--silent"] : ["test"];
      // Prefer explicit script name when not plain "test"
      const scriptName =
        scripts["test:unit"] && script === scripts["test:unit"]
          ? "test:unit"
          : scripts["check"] && script === scripts["check"]
            ? "check"
            : "test";
      if (scriptName === "test") {
        return { command: pm, args: runArgs, display: `${pm} test` };
      }
      return {
        command: pm,
        args: pm === "npm" ? ["run", scriptName] : ["run", scriptName],
        display: `${pm} run ${scriptName}`,
      };
    }
  } catch {
    /* no package.json */
  }

  if (await exists(join(cwd, "Cargo.toml"))) {
    return { command: "cargo", args: ["test", "--quiet"], display: "cargo test" };
  }
  if (await exists(join(cwd, "go.mod"))) {
    return { command: "go", args: ["test", "./..."], display: "go test ./..." };
  }
  if (await exists(join(cwd, "pyproject.toml")) || (await exists(join(cwd, "pytest.ini")))) {
    return { command: "python", args: ["-m", "pytest", "-q"], display: "pytest" };
  }
  if (await exists(join(cwd, "gradlew"))) {
    return { command: join(cwd, "gradlew"), args: ["test", "-q"], display: "./gradlew test" };
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        code: 124,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + "\n[timed out]",
      });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: e.message });
    });
  });
}
