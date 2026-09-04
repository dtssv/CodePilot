# @codepilot/core 公共 API 契约（各端并行开发的依据）

`@codepilot/core` (packages/core) 的 `src/index.ts` 必须导出以下符号。其他包/应用只依赖这些导出。

```ts
// ===== 事件模型 =====
export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; toolCallId: string; content: string; isError?: boolean; artifactRef?: string }
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface PlanStep { id: string; title: string; status: "pending" | "in_progress" | "completed" | "blocked" }

export type AgentMode = "chat" | "plan" | "agent";

export type Event =
  | { type: "message"; id: string; role: "user" | "assistant"; content: ContentBlock[]; model?: string }
  | { type: "message_delta"; messageId: string; delta: { type: "text"; text: string } | { type: "tool_input_json"; toolCallId: string; partialJson: string } }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean; artifactRef?: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "usage"; usage: UsageInfo }
  | { type: "compaction"; summary: string }
  | { type: "status"; status: "idle" | "running" | "waiting_permission" | "compacting" }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "mode"; mode: AgentMode };

export interface UsageInfo { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number }

// ===== 权限 =====
export type PermissionMode = "ask" | "auto-edit" | "yolo";
export interface PermissionRequest { requestId: string; toolName: string; input: unknown; reason: string }
export type PermissionDecision = "allow" | "deny" | "always";

// ===== 协作模式 =====
// Cursor 风格的协作模式（AgentMode）。控制哪些工具可用以及系统提示的措辞。
// - "chat":  只读问答。仅 read_file/glob/grep/ls/read_artifact/web_fetch 可用；
//            bash/write_file/edit_file/task/plan_update 禁用；
//            系统提示追加"当前为问答模式，不要修改文件，直接给出建议与代码片段"。
// - "plan":  只读 + plan_update。可调用 read 系列工具与 plan_update；
//            bash/write_file/edit_file/task 禁用；
//            系统提示追加"探索代码并产出实施计划，不要做任何修改"。
// - "agent": 完整自主执行（默认）。

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
  agentMode?: AgentMode;      // 默认协作模式（默认 "agent"）
}
export function loadConfig(cwd: string): Promise<CodepilotConfig>;

// ===== 会话 =====
export interface SessionOptions {
  cwd: string;
  config?: CodepilotConfig;
  sessionId?: string;          // 恢复已有会话
  systemPromptExtra?: string;
  model?: string;
  agentMode?: AgentMode;       // 初始协作模式（默认 "agent"）
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  /** 发送用户消息；完成（含所有工具调用轮次）后 resolve */
  prompt(text: string, images?: { mediaType: string; base64: string }[]): Promise<void>;
  cancel(): void;
  /** 运行时切换协作模式。从下一轮 prompt() 起生效：影响系统提示中工具列表
   *  与模式段落，并改变 provider 请求中的 tool 表。会立即发出一个
   *  `{type:"mode", mode}` 事件（也会持久化到 JSONL）。 */
  setAgentMode(mode: AgentMode): Promise<void>;
  /** 当前协作模式。 */
  getAgentMode(): AgentMode;
  /** 订阅事件流，返回退订函数。历史事件在订阅时先重放。 */
  subscribe(listener: (e: Event) => void): () => void;
  getEvents(): Event[];
  fork(atEventIndex?: number): Promise<Session>;
  dispose(): Promise<void>;
}
export function createSession(opts: SessionOptions): Promise<Session>;
export function listSessions(cwd?: string): Promise<{ id: string; title: string; updatedAt: number; cwd: string }[]>;

// ===== 工具模式过滤（纯函数） =====
// 给定一组工具与 AgentMode，返回该模式下应该暴露给 provider 的子集。纯函数，可单测。
export function filterToolsByMode(tools: readonly ToolDef[], mode: AgentMode): ToolDef[];
export function filterToolsByModeFromRegistry(registry: ToolRegistry, mode: AgentMode): ToolDef[];
export function filterToolNames(tools: readonly ToolDef[], mode: AgentMode): string[];

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
