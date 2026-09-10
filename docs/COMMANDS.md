# Slash 命令系统（自定义命令）

> 参考 claude-code 的 `.claude/commands/*.md` 机制：自定义命令是一个带 YAML
> frontmatter 的 markdown 文件，文件体作为 prompt 模板。用户在 TUI 里输入
> `/name <args>` 时，文件体被插值后作为下一条用户消息发送给 agent。
> 可选 frontmatter 控制单轮的模型 / 工具权限覆盖。

## 文件结构

命令是 `commands/` 目录下的单个 `.md` 文件（不递归扫描子目录）：

```
.codepilot/commands/
├── review.md
├── deploy.md
└── commit.md
```

文件名（去掉 `.md`）就是命令名。**必须是全小写**，可含字母、数字、`-`、`_`，
长度 1–64。混合大小写的文件名会被跳过并给出警告（防止 `Review.md` 静默变成
`/review`）。

每个 `.md` 由 **YAML frontmatter**（`---` 包围，全部可选）和 **markdown 正文**
（prompt 模板）组成。frontmatter 只识别以下键：

| 键 | 必填 | 说明 |
|---|---|---|
| `description` | 否 | 一行摘要，出现在 `/` 自动补全菜单里。缺省时取正文第一段。 |
| `argument-hint` | 否 | 参数提示，例如 `<issue-number>`，出现在命令名旁边。声明了它但用户没给参数时，TUI 显示 `Usage: /name <hint>`。 |
| `allowed-tools` | 否 | 本轮预授权的工具名列表（claude-code 语义）。可以是 YAML flow `[a, b]`、YAML list、或逗号/空格分隔的字符串。授权在下一轮 prompt 后自动清除。 |
| `model` | 否 | 本轮模型覆盖（`inherit` 表示沿用会话模型）。下一轮自动恢复会话模型。 |

示例：

```markdown
---
description: Review a pull request for correctness, style, and risk.
argument-hint: <PR number or URL>
allowed-tools: [bash, read_file, grep]
model: claude-sonnet-4-5
---

# /review

Review the PR. Use $1 as the PR number.

## Workflow
1. `gh pr diff $1`
2. ...
```

## 发现来源（按优先级）

1. **`<repo>/.codepilot/commands/*.md`** — 项目级，最高优先级
2. **`~/.codepilot/commands/*.md`** — 用户级

同名命令按"第一个定义胜出"覆盖——项目级覆盖用户级。

### 内置命令（保留名）

以下名字由 TUI 内置命令占用，自定义文件无法覆盖（会被跳过并警告）：

`help`、`?`、`model`、`mode`、`agent`、`plan`、`compact`、`resume`、`sessions`、
`goal`、`clear`、`exit`、`quit`

## 参数插值

正文中以下占位符会被替换：

| 占位符 | 含义 |
|---|---|
| `$ARGUMENTS` | `/name` 后面的完整参数字符串（原样保留，仅 trim 首尾空白） |
| `$1`、`$2`、… | 按空白拆分的位置参数（1-indexed） |
| `$0` | 等同于 `$ARGUMENTS`（整个参数串） |
| `$$` | 字面量 `$` |

未知的 `$<word>`（如 `$HOME`）**保持原样**，不会误替换。

示例：

```
/review 1234 extra
```

对模板 `Review PR $1. Full args: $ARGUMENTS` 渲染为
`Review PR 1234. Full args: 1234 extra`。

## 单轮覆盖（model / allowed-tools）

`model` 和 `allowed-tools` 是 **turn-scoped**（单轮作用域），遵循 claude-code 语义：

- 调用 `/name` 时，`setTurnOverrides({ model, allowedTools })` 把覆盖压入会话。
- 下一次 `session.prompt()` 使用该模型，并把 `allowed-tools` 作为 "allow" 权限规则
  临时加入会话。
- `prompt()` 的 `finally` 块调用 `clearTurnOverrides()`，弹出本轮压入的规则、
  清除模型覆盖——因此**用户下一条消息恢复会话默认模型与权限姿态**。
- 不会影响 "always" 决策产生的持久会话规则（LIFO 弹出，精确移除本轮压入的数量）。

## API

```ts
// packages/core/src/slashCommands.ts
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  path: string;             // .md 文件的绝对路径
  source: "project" | "user";
  body: string;             // frontmatter 剥离后的 markdown 正文
}

export function parseSlashCommandMd(text: string): SlashCommandFrontmatter;
export function isValidCommandName(name: string): boolean;
export async function discoverSlashCommands(
  cwd: string,
  opts?: DiscoverSlashCommandsOptions
): Promise<DiscoverSlashCommandsResult>;
export function findSlashCommand(
  commands: readonly SlashCommand[],
  name: string
): SlashCommand | null;
export function renderCommandPrompt(command: SlashCommand, args: string): string;
export function interpolateTemplate(
  template: string, args: string, words: string[]
): string;
export function resolveSlashCommand(
  input: string,
  commands: readonly SlashCommand[]
): ResolveResult;
export function commandHelpLine(c: SlashCommand): string;
```

### `DiscoverSlashCommandsOptions`

```ts
interface DiscoverSlashCommandsOptions {
  projectDir?: string;      // 覆盖项目级目录
  userDir?: string;         // 覆盖用户级目录
  reservedNames?: ReadonlySet<string>;  // 保留名集合（内置命令名）
}
```

返回 `{ commands, warnings }`，`warnings` 是非致命问题（无效名、保留名冲突、
文件不可读），宿主可一次性展示。

### `resolveSlashCommand`

完整的 `/name args` → 已解析命令 + 渲染 prompt 的一步式入口：

```ts
type ResolveResult =
  | { ok: true; command: SlashCommand; args: string; prompt: string }
  | { ok: false; reason: "not-a-command" }
  | { ok: false; reason: "not-found"; name: string }
  | { ok: false; reason: "no-args"; command: SlashCommand; message: string };
```

## TUI 集成

TUI (`apps/tui/src/ui/App.tsx`) 在挂载时调用 `discoverSlashCommands(cwd, { reservedNames: BUILTIN_COMMAND_NAMES })`，
把自定义命令与内置命令合并进 `/` 自动补全菜单。输入 `/name args` 时：

1. 先走内置命令分发（`runCommand`）——内置命令永远优先。
2. 内置未命中时，`runCommandWithCustom` 调用 `resolveSlashCommand` 尝试自定义命令。
3. 命中则把渲染后的 prompt 通过 `session.prompt()` 发送，并在发送前调用
   `session.setTurnOverrides({ model, allowedTools })` 应用单轮覆盖。
4. 未命中则显示 `Unknown command: /name. Try /help.`。

### Session 新增方法

```ts
class Session {
  getModel(): string;                                          // 含单轮覆盖
  setModel(model: string): Promise<void>;                      // 持久切换
  setTurnOverrides(opts: { model?: string; allowedTools?: string[] }): void;
  clearTurnOverrides(): void;
  getTurnOverrides(): { model: string | null; allowedTools: string[] | null };
}
```

`PermissionEngine` 新增 `removeLastSessionRules(effect, count)`，供
`clearTurnOverrides` 精确弹出本轮压入的 allow 规则（LIFO），不影响 "always" 决策。

## 设计取舍

- **不引入 YAML 解析器**：复用 skills.ts 的最小 frontmatter 解析，依赖零。
- **内置命令不可被覆盖**：保证控制面稳定（`/model`、`/exit` 等永远可用）。
- **Turn-scoped 覆盖**：`model` / `allowed-tools` 只对触发命令的这一轮生效，
  下一轮自动恢复——既允许命令定制行为，又不污染会话长期状态。
- **文件名必须小写**：避免 `Review.md` 静默变成 `/review` 的惊喜。
- **不递归扫描子目录**：保持命令面扁平可预测（每个命令就是 `commands/` 下的一个文件）。
