// Built-in Stop verification — validity gate at the completion boundary.
//
 // Modes (config `stopVerify`):
 // - "off"    — disabled (default). No extra request at turn end.
 // - "prompt" — small-model judge: code correctness ≠ feature/visual correctness
 // - "tests"  — run a detected project test command when one exists; else allow
 // - true     — alias for "prompt"
 //
 // Default is "off": a post-completion judge call shares the same provider
 // TPM budget as the main run, so after a long task it often 429s, fails open,
 // and adds latency/noise for no effect. Opt in with stopVerify: "prompt".

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Event } from "./types.js";
import type { PreHookResult } from "./hooks.js";
import type { HookResolvers } from "./hooks-handlers.js";

export type StopVerifyMode = "off" | "prompt" | "tests";

export function resolveStopVerifyMode(
  value: boolean | StopVerifyMode | undefined,
): StopVerifyMode {
  if (value === true || value === "prompt") return "prompt";
  if (value === "tests") return "tests";
  // false | "off" | undefined → off (no closing judge request)
  return "off";
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
Decide whether the agent may END this turn.

Block when ANY of these are true:
- The user task is UI / visual / interactive / frontend and there is no evidence of running a dev server, opening a browser, or comparing via screenshots/read_image.
- The agent claims done but only ran syntax/typecheck/lint/\`node --check\` while the task needed feature-level or visual verification.
- Stated acceptance criteria look unmet, or verification was skipped without saying why it was impossible.
- stop_hook_active is true AND the prior block reason was not addressed in the latest assistant work.

Allow when:
- Evidence matches the claim (tests/build for code tasks; browser/screenshot for UI), OR the agent clearly stated verification was impossible and why.
- The change is a narrow code fix with an appropriate automated check, or a Q&A/planning turn with no deliverable to verify.
- stop_hook_active is true and the agent fixed the prior concern.

Respond with JSON only — no markdown:
{"decision":"allow"}
or
{"decision":"block","reason":"one short sentence the agent should act on"}`;

/** Run the built-in Stop verifier for the configured mode. */
export async function runBuiltinStopVerify(
  mode: StopVerifyMode,
  ctx: StopVerifyContext,
): Promise<PreHookResult> {
  if (mode === "off") return { action: "allow", warnings: [] };
  if (mode === "tests") return runTestsVerify(ctx);
  return runPromptVerify(ctx);
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

/** 429 / TPM / gateway overload — not a real "task failed" signal. */
export function isTransientJudgeFailure(message: string): boolean {
  return /\b429\b|rate.?limit|too many requests|tokens limit|访问限制|overloaded|\b529\b|sustaining heavy rate-limiting/i.test(
    message,
  );
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
