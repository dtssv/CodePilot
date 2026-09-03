// Layered system prompt:
//   - static prefix (instructions, tool list, conventions) — kept constant so
//     providers can cache the prefix (Anthropic cache_control, OpenAI prefix
//     caching).
//   - dynamic suffix (cwd, git status, memory summary, plan, current time).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MemoryContents } from "./memory.js";
import type { PlanStep } from "./types.js";

const execFileP = promisify(execFile);

export interface SystemPromptContext {
  cwd: string;
  memory: MemoryContents;
  plan?: PlanStep[];
  toolNames: string[];
  extra?: string;
  model?: string;
  provider?: string;
}

export interface SystemPromptResult {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
}

export async function buildSystemPrompt(
  ctx: SystemPromptContext
): Promise<SystemPromptResult> {
  const staticPrefix = buildStaticPrefix(ctx);
  const dynamicSuffix = await buildDynamicSuffix(ctx);
  const full =
    staticPrefix +
    (staticPrefix.endsWith("\n") ? "" : "\n") +
    dynamicSuffix;
  return { staticPrefix, dynamicSuffix, full };
}

function buildStaticPrefix(ctx: SystemPromptContext): string {
  const lines: string[] = [];
  lines.push("You are CodePilot, a careful, token-efficient software engineering agent.");
  lines.push("");
  lines.push("Operating principles:");
  lines.push("- Prefer minimal, surgical changes; avoid speculative rewrites.");
  lines.push("- Read files before editing. Use grep/glob to locate code first.");
  lines.push("- Use `edit_file` (search/replace) rather than full file rewrites when possible.");
  lines.push("- When output is large, rely on tool artifacts and `read_artifact` instead of pasting.");
  lines.push("- Keep the user informed by updating the plan with `plan_update` after each meaningful step.");
  lines.push("");
  lines.push("Available tools:");
  for (const n of ctx.toolNames) lines.push(`- ${n}`);
  lines.push("");
  lines.push("Conventions:");
  lines.push("- Bash commands are run via /bin/sh -c; quote carefully.");
  lines.push("- Never modify files outside the current working directory without permission.");
  lines.push("- If a tool call fails, prefer recovery (e.g. retry with adjusted args) over giving up.");
  if (ctx.extra) {
    lines.push("");
    lines.push("Project-specific notes:");
    lines.push(ctx.extra);
  }
  return lines.join("\n");
}

async function buildDynamicSuffix(ctx: SystemPromptContext): Promise<string> {
  const out: string[] = [];
  out.push("## Runtime context");
  out.push(`- cwd: ${ctx.cwd}`);
  out.push(`- provider: ${ctx.provider ?? "auto"}`);
  out.push(`- model: ${ctx.model ?? "(default)"}`);
  out.push(`- time: ${new Date().toISOString()}`);
  const git = await safeGitStatus(ctx.cwd);
  if (git) {
    out.push("");
    out.push("## Git status");
    out.push(git);
  }
  if (ctx.memory.project || ctx.memory.user) {
    out.push("");
    out.push("## Memory");
    if (ctx.memory.project) {
      out.push("### Project (CODEPILOT.md)");
      out.push(ctx.memory.project);
    }
    if (ctx.memory.user) {
      out.push("### User (~/.codepilot/MEMORY.md)");
      out.push(ctx.memory.user);
    }
  }
  if (ctx.plan && ctx.plan.length > 0) {
    out.push("");
    out.push("## Current plan");
    for (const step of ctx.plan) {
      out.push(`- [${step.status}] ${step.id} — ${step.title}`);
    }
  }
  return out.join("\n");
}

async function safeGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const { stdout: branch } = await execFileP(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 }
    );
    const { stdout: status } = await execFileP(
      "git",
      ["status", "--short", "--branch"],
      { cwd, timeout: 2000 }
    );
    return `branch: ${branch.trim()}\n${status.trim()}`;
  } catch {
    return undefined;
  }
}
