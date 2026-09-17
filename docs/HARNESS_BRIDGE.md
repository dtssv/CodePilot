# harness_bridge：外部 AI 编码代理桥接

> `harness_bridge` 允许 CodePilot 将外部 AI 编码代理（如 claude-code、codex 或自定义 CLI）作为**子代理**调用。通过标准子进程协议，CodePilot 可以在当前会话中直接调度其他 agent runtime，获取它们对特定任务的输出。

## 概述

`harness_bridge` 的核心定位是**外部代理桥接器**：

- **与 `task` 的区别**：`task` 生成的是 CodePilot 进程内的子代理；而 `harness_bridge` 调用的是**外部**独立 CLI 二进制文件（如 `claude`、`codex` 或任意自定义命令）。
- **一次性非交互模式**：被调用的 harness 以 one-shot 方式运行（如 `claude -p` 或 `codex exec`），接收 prompt 作为参数，执行完毕后返回最终输出。
- **安全沙箱**：子进程继承与 bash 工具相同的 OS 级沙箱限制（seatbelt / bwrap / wsl-bwrap），写权限被限制在工作区内。

典型使用场景：需要 claude-code 的特定能力（如第二意见）、利用 codex 的专有功能、或桥接内部自研的 agent 工具。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `harness` | enum | **是** | 要调用的外部 harness：`"claude-code"`（claude CLI）、`"codex"`（codex CLI）、或 `"custom"`（自定义命令）。 |
| `prompt` | string | **是** | 传递给外部 harness 的自包含目标描述。 |
| `cwd` | string | 否 | 子进程工作目录（默认：当前会话 cwd）。 |
| `timeout_ms` | number | 否 | 最大执行时间（毫秒）。默认 `120000`（2 分钟），上限 `600000`（10 分钟）。 |
| `custom_command` | string | 当 `harness="custom"` 时必填 | 要运行的 CLI 命令（如 `"my-agent"`）。 |
| `custom_args` | string[] | 否 | 附加参数列表，**插入在 prompt 之前**。 |

## Harness 类型与命令构造

`harness_bridge` 根据 `harness` 类型自动构造 shell 命令：

| 类型 | 实际执行的命令 | 说明 |
|---|---|---|
| `claude-code` | `claude -p --output-format json <prompt>` | 需要 `claude` CLI 在 PATH 中。使用 JSON envelope 模式，提取 `.result` 字段。 |
| `codex` | `codex exec <prompt>` | 需要 `codex` CLI 在 PATH 中。直接返回 stdout。 |
| `custom` | `<custom_command> <custom_args...> <prompt>` | `custom_command` 必填；`custom_args` 中的每个元素都会经过 shell 转义后插入 prompt 之前。 |

**Shell 转义**：所有参数（包括 prompt 和 custom_args）都会通过单引号包裹并进行内部单引号转义（`'` → `'\''`），确保特殊字符安全传递。

## 输出适配

不同 harness 的输出格式不同，`harness_bridge` 会自动适配：

| 类型 | 输出处理 | 降级策略 |
|---|---|---|
| `claude-code` | 解析 `--output-format json` 的 JSON envelope，提取 `result` 字段 | 如果 stdout 不是合法 JSON 或缺少 `result` 字段，则回退到原始 stdout |
| `codex` / `custom` | 直接返回原始 stdout | — |

如果 `claude-code` 的 JSON 中 `is_error` 为 `true`，会返回截断后的错误信息（前 2000 字符）。

## 安全模型

`harness_bridge` 采用与 bash 工具相同的安全姿态：

- **沙箱继承**：命令通过 `wrapCommand` 包装，继承当前会话的 OS 沙箱策略（seatbelt / bwrap / wsl-bwrap）。子进程的文件系统写权限被限制在工作区内，网络访问遵循会话配置。
- **无 stdin**：子进程 stdin 被设为 `"ignore"`，防止 harness 挂起等待交互输入。
- **超时强制**：默认 2 分钟，最长 10 分钟。超时后发送 `SIGTERM` 终止子进程。
- **输出截断**：
  - 软上限：缓冲超过 **5 MB** 时立即终止子进程。
  - 硬上限：返回给模型的输出被截断至 **100 KB**，并附加截断标记。

## 使用示例

### 委托 claude-code 获取第二意见

```json
{
  "harness": "claude-code",
  "prompt": "审查 /Users/zyf/project/src/auth.ts 中的权限检查逻辑，找出潜在的越权漏洞",
  "timeout_ms": 180000
}
```

CodePilot 会调用本地安装的 `claude` CLI，将返回的 JSON 中的 `result` 字段作为子代理意见整合进当前上下文。

### 使用 codex 的特定能力

```json
{
  "harness": "codex",
  "prompt": "将 src/utils.ts 中的回调风格函数重构为 async/await",
  "cwd": "/Users/zyf/project"
}
```

利用 codex 在代码重构方面的特定训练优势，处理 CodePilot 当前模型可能不擅长的模式转换。

### 桥接内部自定义 harness

假设公司内部有一个名为 `internal-ai` 的 CLI 工具：

```json
{
  "harness": "custom",
  "custom_command": "internal-ai",
  "custom_args": ["--mode", "strict", "--format", "markdown"],
  "prompt": "分析当前目录下的 API 变更是否破坏向后兼容性"
}
```

实际执行：`internal-ai --mode strict --format markdown '<prompt>'`

## 何时使用 vs 何时避免

| 场景 | 推荐工具 | 原因 |
|---|---|---|
| 需要不同模型/供应商的"第二意见"或交叉验证 | `harness_bridge` | 利用外部 CLI 的独立 runtime 和模型 |
| 需要特定 CLI 的专有功能（如 codex 的特定训练数据） | `harness_bridge` | 外部 harness 可能有 CodePilot 不具备的能力 |
| 需要并行执行多个独立子任务 | `task` | `task` 是进程内子代理，开销更小，通信更快 |
| 需要交互式多轮对话 | `task` 或主会话 | `harness_bridge` 是单轮一次性调用，无 stdin 交互 |
| 只是需要读文件、写代码、跑测试 | 直接使用 `read`/`edit`/`bash` | 避免不必要的进程开销和复杂性 |

## 错误处理

| 错误类型 | 触发条件 | 返回行为 |
|---|---|---|
| **命令未找到** | `claude`/`codex` 不在 PATH 中，或 `custom_command` 不存在 | `isError: true`，输出包含 `ENOENT` 或 `command not found` 或 `[exit 127]` |
| **执行超时** | 超过 `timeout_ms`（默认 120s，最大 600s） | `isError: true`，输出包含超时提示和部分截断的 stdout/stderr |
| **非零退出码** | harness 进程以非 0 状态退出 | `isError: true`，输出前缀为 `[exit <code>]`，stderr 被附加在 `[stderr]` 标记后 |
| **空输出** | 进程成功退出但无 stdout/stderr | 返回 `(harness produced no output)`，`isError: false` |
| **输出过大** | 缓冲超过 5 MB | 进程被 SIGTERM 杀死，按超时处理（返回部分输出） |
| **JSON 解析失败** | `claude-code` 输出非 JSON | 回退到原始文本，不视为错误（除非 exit code 非 0） |

所有错误输出都会被截断至 100 KB，确保不会占用过多上下文窗口。
