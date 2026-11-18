import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { buildSingleProvider, userMessage } from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import { assertInitialized, gitCwd, workspacePath, WORKSPACE_MAX_BYTES, type ServerContext } from "../context.js";
import { loadConfigSafe } from "../loadConfigSafe.js";
import { liveSessions } from "../liveSessions.js";
import type {
  GitActionParams,
  GitBranchesResult,
  GitCheckoutParams,
  GitCommitMessageResult,
  GitCommitParams,
  GitGenericResult,
  GitPushPullParams,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusResult,
} from "../wireTypes.js";

const execFileAsync = promisify(execFile);

export async function handleWorkspaceGitStatus(
  ctx: ServerContext,
  params?: { cwd?: string },
): Promise<WorkspaceGitStatusResult> {
  assertInitialized(ctx);
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      gitCwd(ctx, params?.cwd),
      "status",
      "--short",
      "--branch",
      "--porcelain=v1",
      "-uall",
    ]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const branch = lines.find((l) => l.startsWith("## "))?.slice(3) ?? "(detached/unknown)";
    const files = lines
      .filter((l) => !l.startsWith("## "))
      .map((l) => ({
        index: l[0] ?? " ",
        worktree: l[1] ?? " ",
        status: l.slice(0, 2),
        path: l.slice(3),
      }));
    return { branch, files };
  } catch (err) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      `git status unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleWorkspaceGitDiff(
  ctx: ServerContext,
  params: WorkspaceGitDiffParams,
): Promise<WorkspaceGitDiffResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["-C", root, "diff", "--no-ext-diff", "--no-color", "--no-renames"];
  if (params.staged) args.push("--cached");
  if (params.path) args.push("--", workspacePath(ctx, params.path, params.cwd).rel);
  try {
    const { stdout } = await execFileAsync("git", args, { maxBuffer: 1024 * 1024 });
    const bytes = Buffer.from(stdout, "utf8");
    const truncated = bytes.byteLength > WORKSPACE_MAX_BYTES;
    return {
      path: params.path,
      diff: bytes.subarray(0, WORKSPACE_MAX_BYTES).toString("utf8"),
      truncated,
    };
  } catch (err) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      `git diff unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Run a git subcommand in the workspace, returning combined output. */
async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return (stdout + (stderr ? `\n${stderr}` : "")).trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stderr || e.stdout || e.message || String(err)).trim();
    throw new RpcError(ErrorCode.InvalidRequest, msg);
  }
}

export async function handleGitBranches(
  ctx: ServerContext,
  params?: { cwd?: string },
): Promise<GitBranchesResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params?.cwd);
  const out = await runGit(root, ["branch", "--list", "-vv", "--no-color", "--sort=-committerdate"]);
  const branches: GitBranchesResult["branches"] = [];
  let current = "";
  let detached = false;
  for (const raw of out.split(/\r?\n/).filter(Boolean)) {
    const isCurrent = raw.startsWith("*");
    const line = raw.replace(/^\*?\s+/, "");
    // Detached HEAD shows as "(HEAD detached at abc123)".
    if (line.startsWith("(HEAD")) {
      if (isCurrent) {
        detached = true;
        current = line.replace(/[()]/g, "");
      }
      continue;
    }
    const name = line.split(/\s+/)[0] ?? "";
    if (!name) continue;
    const upstreamMatch = line.match(/\[([^\]:]+)(?::\s*(ahead \d+)?,?\s*(behind \d+)?)?\]/);
    const upstream = upstreamMatch?.[1];
    const ahead = upstreamMatch?.[2] ? Number(upstreamMatch[2].replace("ahead ", "")) : undefined;
    const behind = upstreamMatch?.[3] ? Number(upstreamMatch[3].replace("behind ", "")) : undefined;
    branches.push({ name, current: isCurrent, upstream, ahead, behind });
    if (isCurrent) current = name;
  }
  // Recent tags (newest first). Best-effort — empty on repos without tags.
  let tags: string[] = [];
  try {
    const tagOut = await runGit(root, ["tag", "--sort=-creatordate", "--list"]);
    tags = tagOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    tags = [];
  }
  return { current, branches, tags, detached };
}

export async function handleGitInit(
  ctx: ServerContext,
  params?: { cwd?: string },
): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const output = await runGit(gitCwd(ctx, params?.cwd), ["init"]);
  return { ok: true, output };
}

export async function handleGitStage(ctx: ServerContext, params: GitActionParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = params.paths && params.paths.length > 0 ? ["add", "--", ...params.paths] : ["add", "-A"];
  const output = await runGit(root, args);
  return { ok: true, output };
}

export async function handleGitUnstage(ctx: ServerContext, params: GitActionParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args =
    params.paths && params.paths.length > 0
      ? ["restore", "--staged", "--", ...params.paths]
      : ["reset", "-q"];
  const output = await runGit(root, args);
  return { ok: true, output };
}

export async function handleGitCommit(ctx: ServerContext, params: GitCommitParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  if (!params.message || !params.message.trim()) throw new RpcError(ErrorCode.InvalidParams, "commit message required");
  const root = gitCwd(ctx, params.cwd);
  const args = ["commit", "-m", params.message];
  if (params.all) args.splice(1, 0, "-a");
  const output = await runGit(root, args);
  return { ok: true, output };
}

export async function handleGitPush(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["push"];
  if (params.setUpstream && params.remote && params.branch) args.push("-u", params.remote, params.branch);
  else {
    if (params.remote) args.push(params.remote);
    if (params.branch) args.push(params.branch);
  }
  const output = await runGit(root, args);
  return { ok: true, output };
}

export async function handleGitPull(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["pull", "--no-rebase"];
  if (params.remote) args.push(params.remote);
  if (params.branch) args.push(params.branch);
  const output = await runGit(root, args);
  return { ok: true, output };
}

export async function handleGitFetch(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const output = await runGit(gitCwd(ctx, params.cwd), ["fetch", "--all", "--prune"]);
  return { ok: true, output };
}

export async function handleGitCheckout(ctx: ServerContext, params: GitCheckoutParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  if (!params.branch || !params.branch.trim()) throw new RpcError(ErrorCode.InvalidParams, "branch required");
  const root = gitCwd(ctx, params.cwd);
  const args = params.create ? ["checkout", "-b", params.branch] : ["checkout", params.branch];
  const output = await runGit(root, args);
  return { ok: true, output };
}

/** Generate a commit message from the staged diff using the active model. */
export async function handleGitCommitMessage(
  ctx: ServerContext,
  params?: { cwd?: string; sessionId?: string },
): Promise<GitCommitMessageResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params?.cwd);
  let diff = await runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--stat", "-p"]);
  if (!diff.trim()) {
    // Nothing staged — fall back to the full working-tree diff.
    diff = await runGit(root, ["diff", "--no-ext-diff", "--no-color", "--stat", "-p"]);
  }
  if (!diff.trim()) throw new RpcError(ErrorCode.InvalidRequest, "no changes to describe");
  // Cap the diff we send to the model.
  const capped = diff.length > 12000 ? `${diff.slice(0, 12000)}\n…(diff truncated)` : diff;

  // Use the model the workspace's conversation is using: prefer the active
  // session passed by the client, else any live session in this workspace.
  // Fall back to on-disk config when no session is live.
  let live = params?.sessionId ? liveSessions.get(params.sessionId) : undefined;
  if (!live) {
    for (const s of liveSessions.values()) {
      if (resolve(s.session.cwd) === root) {
        live = s;
        break;
      }
    }
  }
  let provider: ReturnType<typeof buildSingleProvider>;
  let model: string;
  // Commit messages are a lightweight one-shot: prefer the workspace
  // conversation's PROVIDER (reachable, user's account) but use its small
  // model when available so we don't hammer the rate-limited chat model.
  // Also relax the retry policy so a transient 429 doesn't abort after a few
  // tries the way the chat loop's fast-fail does.
  const patientRetry = { retryAbortOnDelayMs: 0, maxRetries: 3, baseRetryDelayMs: 1000 };
  if (live) {
    try {
      const cfg = { ...live.session.getConfig(), ...patientRetry };
      provider = buildSingleProvider(cfg);
      model = provider.smallModel || live.session.getModel() || provider.defaultModel;
    } catch (err) {
      throw new RpcError(
        ErrorCode.InternalError,
        `no model configured for commit messages: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const config = { ...((await loadConfigSafe(root)) ?? {}), ...patientRetry };
    try {
      provider = buildSingleProvider(config);
    } catch (err) {
      throw new RpcError(
        ErrorCode.InternalError,
        `no model configured for commit messages: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    model = provider.smallModel || provider.defaultModel;
  }
  const systemPrompt =
    "You write concise git commit messages in the Conventional Commits style. " +
    "Return ONLY the commit message — a short imperative subject line (≤ 72 chars), " +
    "optionally followed by a blank line and a brief body. No code fences, no preamble.";
  const prompt = `Write a commit message for this diff:\n\n${capped}`;
  let text = "";
  try {
    for await (const ev of provider.stream({
      model,
      systemPrompt,
      messages: [userMessage(prompt)],
      maxTokens: 400,
    })) {
      if (ev.kind === "text_delta") text += ev.text;
      else if (ev.kind === "error") throw new Error(ev.message);
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const rateLimited = /rate.?limit|429|backoff|fast-fail|too many requests/i.test(raw);
    const hint = rateLimited
      ? " The model is being rate-limited — set a lighter `smallModel` in settings, or try again shortly."
      : "";
    throw new RpcError(ErrorCode.InternalError, `commit message generation failed: ${raw}${hint}`);
  }
  const message = text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();
  if (!message) throw new RpcError(ErrorCode.InternalError, "model returned an empty commit message");
  return { message };
}