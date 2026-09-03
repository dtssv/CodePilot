# @codepilot/core 公共 API 契约（各端并行开发的依据）

`@codepilot/core` (packages/core) 的 `src/index.ts` 必须导出以下符号。其他包/应用只依赖这些导出。

```ts
// ===== 事件模型 =====
export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; toolCallId: string; content: string; isError?: boolean; artifactRef?: string }
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface PlanStep { id: string; title: string; status: "pending" | "in_progress" | "completed" | "blocked" }

export type Event =
  | { type: "message"; id: string; role: "user" | "assistant"; content: ContentBlock[]; model?: string }
  | { type: "message_delta"; messageId: string; delta: { type: "text"; text: string } | { type: "tool_input_json"; toolCallId: string; partialJson: string } }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean; artifactRef?: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "usage"; usage: UsageInfo }
  | { type: "compaction"; summary: string }
  | { type: "status"; status: "idle" | "running" | "waiting_permission" | "compacting" }
  | { type: "error"; message: string; recoverable: boolean };

export interface UsageInfo { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number }

// ===== 权限 =====
export type PermissionMode = "ask" | "auto-edit" | "yolo";
export interface PermissionRequest { requestId: string; toolName: string; input: unknown; reason: string }
export type PermissionDecision = "allow" | "deny" | "always";

// ===== 配置 =====
export interface CodepilotConfig {
  provider?: "anthropic" | "openai" | "copilot";
  model?: string;
  smallModel?: string;
  apiKey?: string;            // 否则读环境变量 ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN
  baseURL?: string;           // OpenAI 兼容端点
  permissionMode?: PermissionMode;
  maxTokens?: number;
  contextWindow?: number;     // 触发压缩的阈值（tokens）
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  autoApprove?: string[];     // 工具名/命令正则白名单
}
export function loadConfig(cwd: string): Promise<CodepilotConfig>;

// ===== 会话 =====
export interface SessionOptions {
  cwd: string;
  config?: CodepilotConfig;
  sessionId?: string;          // 恢复已有会话
  systemPromptExtra?: string;
  model?: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  /** 发送用户消息；完成（含所有工具调用轮次）后 resolve */
  prompt(text: string, images?: { mediaType: string; base64: string }[]): Promise<void>;
  cancel(): void;
  /** 订阅事件流，返回退订函数。历史事件在订阅时先重放。 */
  subscribe(listener: (e: Event) => void): () => void;
  getEvents(): Event[];
  fork(atEventIndex?: number): Promise<Session>;
  dispose(): Promise<void>;
}
export function createSession(opts: SessionOptions): Promise<Session>;
export function listSessions(cwd?: string): Promise<{ id: string; title: string; updatedAt: number; cwd: string }[]>;

// ===== 长程目标模式 =====
export interface GoalRunOptions extends SessionOptions { objective: string; maxRounds?: number; onRound?: (round: number, status: string) => void }
export interface GoalRunResult { status: "completed" | "blocked" | "round_limit"; reason?: string }
export function runGoal(opts: GoalRunOptions): Promise<GoalRunResult>;

// ===== CLI 入口 =====
// packages/core 提供 bin: codepilot
//   codepilot serve            — 以 protocol(NDJSON JSON-RPC) stdio 服务运行
//   codepilot run "<task>"     — 一次性非交互执行（类似 claude -p / codex exec），--json 输出事件流
//   codepilot goal "<obj>"     — 长程目标模式
// serve 模式由 packages/protocol 复用 core 实现，core 仅导出 createSession 等；serve 命令实现在 packages/protocol。
```

## 环境约定
- 会话存储：`~/.codepilot/sessions/<id>.jsonl`（事件追加）
- 记忆：`~/.codepilot/MEMORY.md`（用户级）、`<repo>/CODEPILOT.md`（项目级）
- 工件存储：`.codepilot/artifacts/`（大工具结果）
- 配置：`~/.codepilot/config.json` 与 `<repo>/.codepilot/config.json` 合并（repo 优先）
