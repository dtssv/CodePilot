// UI strings in English and Chinese. Keys are English phrases so a missing
// translation degrades to readable English.
//
 // Preference order: ?lang= URL → saved localStorage → host IDE → browser.

import { useEffect, useState } from "react";

export type Locale = "en" | "zh";

const STORAGE_KEY = "codepilot.locale";

const ZH: Record<string, string> = {
  "See the attached image.": "请看附带的图片。",
  "See the attached file.": "请看附带的文件。",
  "Remove image": "移除图片",
  "Remove attachment": "移除附件",
  "Attach images": "添加图片",
  "Attach files": "添加文件",
  "Attach images (or paste / drop; @path/to/image.png also works)": "添加图片（也可粘贴、拖入，或在输入中写 @路径/图片.png）",
  "Attach files (or paste / drop; @path/to/image.png also works)": "添加文件（也可粘贴、拖入；图片可用 @路径/图片.png）",
  Connect: "连接",
  "Connecting…": "连接中…",
  Disconnect: "断开",
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  reconnecting: "重连中",
  Server: "服务地址",
  Token: "令牌",
  "Working directory": "工作目录",
  Workspaces: "工作区",
  "No workspace yet": "尚未打开工作区",
  Settings: "设置",
  "Providers & models": "服务商与模型",
  Providers: "服务商",
  Endpoints: "端点",
  models: "个模型",
  "Built-in": "内置",
  "Built-in vendors": "内置服务商",
  Custom: "自定义",
  "Add custom provider": "添加自定义服务商",
  "Add endpoint": "添加服务商",
  "Adds another key / endpoint": "添加另一个密钥 / 端点",
  "Select a provider on the left.": "请从左侧选择服务商。",
  "Select an endpoint on the left, or add a new one.": "请从左侧选择端点，或添加新端点。",
  "No endpoints yet — add one below.": "还没有端点 — 点下方添加。",
  "New endpoint": "新端点",
  "Custom OpenAI-compatible": "自定义 OpenAI 兼容",
  "Custom (OpenAI protocol)": "自定义（OpenAI 协议）",
  "Custom (Claude protocol)": "自定义（Claude 协议）",
  Protocol: "协议",
  "OpenAI protocol": "OpenAI 协议",
  "Claude protocol": "Claude 协议",
  "Endpoint is built-in — no baseURL needed.": "内置端点，无需填写 baseURL。",
  "Paste API key": "粘贴 API Key",
  "Fetch models": "获取模型列表",
  "Fetching…": "获取中…",
  "Then tick the models you want in the picker.": "选择模型。",
  "Enter an API key before fetching models": "请先填写 API Key 再获取模型",
  "Enter an API key, then fetch the real model list.": "请先填写 API Key，再获取模型列表。",
  "No models yet — click Fetch models, then tick what you want.":
    "暂无模型 — 点击「获取模型列表」，再勾选要用的模型。",
  "Context window": "上下文窗口",
  "max (provider)": "上限（服务商）",
  "Max output tokens": "最大输出 token",
  Expand: "展开",
  Collapse: "收起",
  Modalities: "模态",
  text: "文本",
  image: "图片",
  audio: "语音",
  video: "视频",
  "Default model": "默认模型",
  "Set as default": "设为默认",
  "Clear saved": "清除已保存",
  "Provider saved": "服务商已保存",
  "baseURL is required for custom providers": "自定义服务商需要填写 baseURL",
  "Select at least one model": "请至少选择一个模型",
  "Save the provider before setting it as default": "请先保存服务商再设为默认",
  "No models returned — check baseURL / apiKey": "未返回模型，请检查 baseURL / apiKey",
  Files: "文件",
  "Open workspace…": "打开工作区…",
  "Open folder…": "打开工作区…",
  "Open this folder": "打开此文件夹",
  "No subfolders": "没有子文件夹",
  "System folder picker is not available on this host": "当前主机不支持系统文件夹选择器",
  Trajectory: "轨迹",
  "No steps yet — send a message to start this session’s trajectory.":
    "还没有步骤 — 发送消息后即可查看本次会话轨迹。",
  "Session totals": "会话合计",
  Turn: "轮次",
  Request: "请求",
  Response: "响应",
  Metrics: "指标",
  Error: "错误",
  Compaction: "压缩",
  Mode: "模式",
  TTFT: "首 Token",
  Duration: "耗时",
  "Input tokens": "输入 tokens",
  "Output tokens": "输出 tokens",
  "Cache read": "缓存读",
  "Cache write": "缓存写",
  Cost: "费用",
  Input: "输入",
  "Show result": "显示结果",
  "Hide result": "隐藏结果",
  You: "你",
  Assistant: "助手",
  "Close workspace": "关闭工作区",
  "Open a workspace": "打开工作区",
  "Waiting for workspace": "等待工作区",
  "This remote session uses the host workspace. Ask the host to open a folder first.":
    "远程会话使用主机上的工作区，请先让主机打开文件夹。",
  "Remote control": "远程控制",
  "Open a workspace to start chatting.": "打开工作区后开始对话。",
  "Open a workspace folder to start chatting.": "打开工作区后开始对话。",
  "Sessions are tied to a workspace. Open one or more from the sidebar.":
    "会话与工作区绑定。可在侧栏打开一个或多个工作区。",
  "Sessions are tied to a folder. Open one or more workspaces from the sidebar.":
    "会话与工作区绑定。可在侧栏打开一个或多个工作区。",
  "Connect to CodePilot": "连接 CodePilot",
  "Run the command below in your project, then paste the URL it prints.": "在项目目录运行下面的命令，然后粘贴输出的地址。",
  "Run the command below, then paste the URL it prints. Open a workspace folder after connecting.":
    "运行下面的命令，粘贴输出的地址。连接后再打开工作区。",
  New: "新建",
  "New chat": "新对话",
  "New task": "新建任务",
  Sessions: "会话",
  Tasks: "任务",
  History: "历史",
  "Search…": "搜索…",
  "No saved sessions yet.": "还没有会话记录。",
  "No tasks yet.": "还没有任务。",
  "Show more": "更多",
  Previous: "上一页",
  Next: "下一页",
  Today: "今天",
  Yesterday: "昨天",
  Earlier: "更早",
  "Fork from here": "从这里分叉",
  Refresh: "刷新",
  Ask: "问答",
  Plan: "计划",
  Agent: "智能体",
  "Read-only Q&A": "只读问答，不改动文件",
  "Explore and write a plan, no changes": "只读探索并产出计划",
  "Edit files and run commands": "自主编辑文件和执行命令",
  "Ask CodePilot…": "向 CodePilot 提问…",
  "Describe a task for CodePilot…": "描述你想让 CodePilot 完成的任务…",
  "Connect and open a session to start…": "连接并打开会话后开始…",
  Send: "发送",
  Queue: "排队",
  Inject: "注入",
  Stop: "停止",
  "Enter to send · Shift+Enter for newline": "Enter 发送 · Shift+Enter 换行",
  "Queued on Enter · ⌘↵ inject into current run…": "Enter 排队，完成后执行 · ⌘↵ 立刻追加到当前任务…",
  "Inject into current run (⌘↵)": "立刻追加到当前任务（⌘↵）",
  "Inject into current run": "立刻追加到当前任务",
  "Queue for after this run (Enter)": "排队，当前任务结束后执行（Enter）",
  "Remove from queue": "移出队列",
  Queued: "队列",
  "Queued messages": "排队中的消息",
  "Edit queued message": "编辑排队消息",
  "Send now": "立刻注入",
  "Send now (inject into current run)": "立刻注入当前任务（下一轮生效，不中断）",
  "Queued — will run after the current task": "已排队 — 当前任务结束后执行",
  "Injected into the current run": "已追加到当前任务",
  "Verifying… continuing": "完成校验未通过，继续执行",
  Thinking: "思考中",
  "Thinking…": "思考中…",
  "Thinking intensity": "思考强度",
  "Think off": "关",
  "Think low": "低",
  "Think medium": "中",
  "Think high": "高",
  "Thought process": "思考过程",
  Thought: "思考过程",
  "Show thinking": "查看思考",
  "Hide thinking": "收起思考",
  "Waiting for model response": "等待模型回复",
  "Running tools": "正在执行",
  "Back to main task": "返回主任务",
  "Subtask": "子任务",
  "View subtask": "查看子任务执行情况",
  Working: "执行中",
  "Waiting for approval": "等待批准",
  "Waiting for your answer": "等待你的回答",
  "Compacting context": "正在压缩上下文",
  Ready: "就绪",
  steps: "个步骤",
  step: "个步骤",
  "Ran": "已执行",
  "Running": "执行中",
  input: "输入",
  result: "结果",
  error: "错误",
  "Full output saved as artifact": "完整输出已保存为 artifact",
  "Plan updated": "计划已更新",
  "Context compacted": "上下文已压缩",
  "Archived large results": "已归档大结果（可取回）",
  "Mode switched to": "已切换到",
  Recommended: "推荐",
  Toggle: "切换",
  Select: "选择",
  Retry: "重试",
  "Retrying": "正在重试",
  "Connection hiccup, retrying": "网络波动，正在重试",
  "Something went wrong": "出错了",
  "Permission required": "需要你的批准",
  "CodePilot wants to run": "CodePilot 想要执行",
  "Allow once": "允许一次",
  "Always allow": "始终允许",
  "Allow folder once": "允许此目录一次",
  "Always allow folder": "始终允许此目录",
  "Save this folder to sandbox.writablePaths for future sessions":
    "将此目录写入 sandbox.writablePaths，之后会话也生效",
  Deny: "拒绝",
  "The agent is asking": "CodePilot 想确认",
  "or type an answer": "或者输入你的回答",
  Skip: "跳过",
  Answer: "提交",
  Progress: "任务进度",
  "No plan yet": "还没有计划",
  Deliverables: "产出文件",
  "Files the agent creates or edits show up here.": "智能体创建或修改的文件会显示在这里。",
  Activity: "当前动态",
  Idle: "空闲",
  "What should we get done today?": "今天想让我帮你完成什么？",
  "CodePilot plans the work, carries it out step by step and reports back.": "CodePilot 会先规划，再一步步执行并汇报结果。",
  "Pick a workspace": "选择工作目录",
  Workspace: "工作区",
  "Bash tool output": "Bash 工具输出",
  "Show bash tool output from this session": "查看本会话中 agent 的 bash 工具输出",
  "Open terminal": "打开终端",
  Terminal: "终端",
  "Agent bash": "Agent bash",
  Shell: "Shell",
  "No shell found": "未找到 shell",
  Open: "打开",
  "Starting…": "正在启动…",
  Exited: "已退出",
  "Click Open to start": "点击「打开」启动",
  "Interactive — Tab completes in the shell": "可交互 — Tab 由 shell 补全",
  "Select a file to preview and edit": "选择文件以预览和编辑",
  "This panel mirrors commands the agent runs with the bash tool. It is not an interactive terminal — ask the agent to run a command, then output appears here.":
    "这里回放 agent 通过 bash 工具执行的命令，不是可交互终端。让 agent 跑命令后，输出会出现在这里。",
  "… running": "… 运行中",
  "(no output)": "（无输出）",
  "Change folder": "更换目录",
  Theme: "主题",
  Light: "浅色",
  Dark: "深色",
  "Code view": "编码视图",
  "Agent view": "智能体视图",
  Workbench: "工作台",
  Copy: "复制",
  Copied: "已复制",
  "Open in editor": "在编辑器中打开",
  Preview: "预览",
  "Preview truncated (file larger than 512 KiB).": "预览已截断（文件超过 512 KiB）。",
  Close: "关闭",
  Restart: "重启",
  "Engine stopped": "引擎已停止",
  Updates: "更新",
  Engine: "执行引擎",
  Extension: "插件",
  "Check for updates": "检查更新",
  "Checking…": "检查中…",
  "Up to date": "已是最新",
  "Update available": "有可用更新",
  "Apply engine update": "升级执行引擎",
  "Confirm update": "确认更新",
  "Restart CodePilot after updating the engine.": "升级引擎后请重启 CodePilot。",
  "Engine updates apply to the CLI/daemon (~/.codepilot). Extension updates are separate.":
    "引擎升级作用于 CLI/守护进程（~/.codepilot）；插件升级是另一条通道。",
  "Cannot auto-apply here (not a prefix install). Run: codepilot update":
    "当前无法自动升级（非 ~/.codepilot 安装）。请运行：codepilot update",
  "Open releases": "打开 Releases",
  "Extension updates install via VSIX / IDE marketplace — not via the engine updater.":
    "插件通过 VSIX / IDE 市场安装升级，不走引擎自动更新。",
  Model: "模型",
  Models: "模型",
  Connectors: "连接器",
  Skills: "技能",
  "MCP marketplace": "MCP 市场",
  "Custom connectors": "自定义连接器",
  "Manage MCP servers — paste JSON, enable or disable installed ones.":
    "管理 MCP 服务：粘贴 JSON 安装，启停已安装项。",
  "MCP service manager": "MCP 服务管理",
  "+ Add MCP": "+ 添加 MCP",
  "Search MCP": "搜索MCP",
  "My MCPs": "我的 MCP",
  enabled: "启用",
  "No MCP installed yet. Click + Add MCP.": "暂无 MCP，点击「+ 添加 MCP」。",
  "No matching MCP.": "无匹配的 MCP。",
  Back: "返回",
  "Refresh capabilities": "刷新能力",
  "Loading capabilities…": "正在加载能力…",
  "Connected — tools / resources / prompts below.": "已连接，工具 / 资源 / 提示如下。",
  "Not connected.": "未连接。",
  Tools: "工具",
  Resources: "资源",
  Prompts: "提示",
  "No tools advertised.": "未公布任何工具。",
  "Upload skill": "上传技能",
  General: "通用",
  Language: "语言",
  "Interface language": "界面语言",
  Chinese: "中文",
  English: "English",
  "Color scheme": "配色方案",
  Layout: "布局",
  "Primary UI layout": "主界面布局",
  "Permission mode": "权限模式",
  "How tools ask for approval": "工具调用时如何征求批准",
  "Ask every time": "每次询问",
  "Auto-edit": "自动编辑",
  "Full access (YOLO)": "完全访问（YOLO）",
  "Default mode": "默认模式",
  "Collaboration mode for new sessions": "新会话的协作模式",
  "Permission mode saved — applies on next connect.": "权限模式已保存 — 下次连接时生效。",
  "Language applies immediately and is remembered on this device.":
    "语言立即生效，并保存在本设备。",
  Remote: "远程控制",
  Schedule: "定时/闲时",
  Install: "安装",
  "Install connector": "安装连接器",
  "Save changes": "保存修改",
  Enable: "启用",
  Disable: "停用",
  Enabled: "已启用",
  Disabled: "已停用",
  Installed: "已安装",
  "Not installed": "未安装",
  "Leave blank to keep current value": "留空则保留原值",
  "Installed connectors can be edited or disabled. Others can be installed.":
    "已安装的连接器可修改或停用；未安装的可以安装。",
  "Search connectors…": "搜索连接器…",
  "Search skills…": "搜索技能…",
  Search: "搜索",
  All: "全部",
  Available: "未安装",
  "Load more": "加载更多",
  "No connectors found.": "未找到连接器。",
  MCP: "MCP",
  Skill: "技能",
  "Update credentials": "更新凭证",
  "Hide credentials": "收起凭证",
  Authorize: "授权",
  "Waiting for authorization…": "等待授权…",
  "Authorization complete.": "授权完成。",
  "Open the URL if the browser did not.": "若浏览器未打开，请点击链接。",
  "This MCP needs authorization. Click Authorize, then refresh.":
    "该 MCP 需要授权。请点击「授权」，完成后再刷新。",
  "Filter tools…": "筛选工具…",
  "Skills guide the agent. Install catalog skills, or enable/disable installed ones.":
    "技能指导代理行为。可安装目录中的技能，或启用/停用已有技能。",
  "Create skill": "创建技能",
  "Builtin skill — saving creates a user copy you can edit.":
    "内置技能 — 保存将写入用户副本，之后可继续修改。",
  "Switch files to edit templates / references next to SKILL.md.":
    "可切换文件编辑 SKILL.md 旁的模板、references、assets 等。",
  "Switch files to edit templates / references next to SKILL.md. Use Add file for new paths.":
    "可切换编辑 SKILL.md 旁的模板等文件；用「添加文件」新建路径。",
  "Add file": "添加文件",
  Create: "创建",
  "Enter a relative path such as templates/example.md":
    "请输入相对路径，例如 templates/example.md",
  "Invalid file path": "文件路径无效",
  Edit: "修改",
  "No skills found.": "暂无技能。",
  Cancel: "取消",
  Docs: "文档",
  "Open authorisation": "去授权 / 创建应用",
  "Curated office connectors (Feishu, DingTalk, Notion…). Open auth, paste credentials, install.":
    "精选办公连接器（飞书、钉钉、Notion…）。打开授权页、填写凭证后安装。",
  "Open an open-source MCP marketplace in the browser, find a server, then paste its JSON below to install.":
    "在浏览器打开开源 MCP 市场，找到想用的服务后，把配置 JSON 粘贴到下方安装。",
  "Loading marketplaces…": "正在加载市场链接…",
  "Paste connector JSON": "粘贴连接器 JSON",
  "Install from JSON": "从 JSON 安装",
  "QR uses your LAN IP (not 127.0.0.1) so the phone can reach this machine":
    "二维码使用局域网 IP（不是 127.0.0.1），手机才能访问本机",
  "Serve must listen on 0.0.0.0 — otherwise the phone cannot connect":
    "服务需以 --host 0.0.0.0 监听，否则手机无法连接",
  "Scoped grant: prompt / cancel / follow only — not config or updates":
    "授权范围仅限发消息/取消/跟随 — 不含改配置或升级",
  "Generate one-time QR": "生成一次性二维码",
  "Scan the QR with your phone — one-time only.": "请用手机扫描二维码（仅一次有效）。",
  Code: "配对码",
  Expires: "过期时间",
  "Revoke all remote access": "撤销全部远程授权",
  "All remote grants revoked.": "已撤销全部远程授权。",
  Title: "标题",
  Prompt: "任务内容",
  "e.g. Summarize unread Feishu docs and draft a status update":
    "例如：汇总未读飞书文档并起草状态更新",
  "Add idle task": "添加闲时任务",
  "Idle task queued — runs when the engine is free.": "闲时任务已入队 — 引擎空闲时执行。",
  "Idle task updated.": "闲时任务已更新。",
  "Host default model": "主机默认模型",
  "Tool mode": "工具模式",
  "Agent (full tools)": "Agent（全工具）",
  "Chat (read-leaning)": "Chat（偏只读）",
  pending: "未执行",
  Remove: "移除",
  "Start a new session or resume one from the sidebar.": "新建一个会话，或从侧边栏恢复历史会话。",
  "Ask anything about your code. Mention files with @path.": "问任何关于代码的问题，可用 @路径 引用文件。",
  "Waiting for the CodePilot engine…": "正在等待 CodePilot 引擎…",
  "Organize a folder": "整理文件夹",
  "Sort the files in this folder into sensible subfolders and give me a summary of what moved.": "把这个目录里的文件按类别整理到合适的子目录中，并告诉我移动了哪些文件。",
  "Write a weekly report": "写一份周报",
  "Read the git log of the last 7 days and write a concise weekly report grouped by theme.": "阅读最近 7 天的 git 提交记录，按主题写一份简洁的周报。",
  "Analyze data": "分析数据",
  "Find the CSV/Excel files here, analyze them and summarize the key findings with numbers.": "找到这里的 CSV/Excel 文件，分析并用数据总结关键发现。",
  "Fix failing tests": "修复失败的测试",
  "Run the test suite, find the failing tests and fix them. Explain each fix.": "运行测试，定位失败用例并修复，说明每一处修改。",
  "Write documentation": "生成文档",
  "Write a README for this project: what it does, how to run it, and the main modules.": "为这个项目写一份 README：做什么、如何运行、主要模块。",
  "Research a topic": "调研总结",
  "Research the topic I describe next on the web and write a sourced summary.": "联网调研我接下来描述的主题，并写一份附带来源的总结。",
  done: "完成",
  failed: "失败",
  "in progress": "进行中",
  of: "/",
  "Show all": "显示全部",
  "Show less": "收起",
  Created: "新建",
  Edited: "修改",
  "Read": "读取",
  "Searched": "搜索",
  "Ran command": "运行命令",
  "Fetched": "抓取",
  "Delegated": "委派子任务",
  "Saved memory": "写入记忆",
  "Updated plan": "更新计划",
  "Asked you": "向你提问",
  Listed: "列出",
  "Called": "调用",
  tokens: "tokens",
  Wrote: "写入",
  "Explain the architecture of this project": "讲解这个项目的整体架构",
  "Find potential bugs in the recent changes": "检查最近改动中的潜在 bug",
  "Write unit tests for the most complex module": "为最复杂的模块补充单元测试",
  "Loading…": "加载中…",
  "Select model": "选择模型",
  "Switch model": "切换模型",
  "No models configured. Open Settings to add a provider.": "尚未配置模型。请打开设置添加服务商。",
  "Provider id is required": "请填写服务商 ID",
  Id: "ID",
  "Display name": "显示名称",
  "leave blank to keep": "留空则保持不变",
  "Remove saved config for": "移除已保存的配置：",
  "Revoke all remote access? Paired devices will need to scan a new code.": "撤销全部远程授权？已配对的设备需要重新扫码。",
  "Remove this scheduled task?": "删除这个定时任务？",
  "Couldn’t load models": "无法加载模型列表",
};

const listeners = new Set<() => void>();

function normalizeLocale(raw: string | undefined | null): Locale | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return undefined;
}

function readSavedLocale(): Locale | undefined {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function detectLocale(): Locale {
  try {
    const forced = normalizeLocale(new URLSearchParams(window.location.search).get("lang"));
    if (forced) return forced;
    const saved = readSavedLocale();
    if (saved) return saved;
    return normalizeLocale(navigator.language) ?? "en";
  } catch {
    return "en";
  }
}

let current: Locale = detectLocale();
try {
  document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
} catch {
  /* SSR / non-DOM */
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore listener errors */
    }
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the user has an explicit saved language preference. */
export function hasSavedLocale(): boolean {
  return readSavedLocale() !== undefined;
}

/**
 * Set UI locale. Pass `{ persist: true }` when the user chooses a language in
 * Settings so it survives refresh. Host/IDE calls should omit persist (or use
 * {@link applyHostLocale}) so a user preference is not overwritten.
 */
export function setLocale(
  locale: string | undefined,
  opts?: { persist?: boolean },
): void {
  const next = normalizeLocale(locale);
  if (!next) return;
  const changed = next !== current;
  current = next;
  try {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  } catch {
    /* ignore */
  }
  if (opts?.persist) {
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch {
      /* ignore */
    }
  }
  if (changed || opts?.persist) notify();
}

/** Apply IDE/host locale only when the user has not chosen a language yet. */
export function applyHostLocale(locale: string | undefined): void {
  if (hasSavedLocale()) return;
  setLocale(locale, { persist: false });
}

export function getLocale(): Locale {
  return current;
}

/** Subscribe to locale changes so the React tree re-renders with new `t()` strings. */
export function useLocale(): Locale {
  const [locale, set] = useState<Locale>(() => getLocale());
  useEffect(() => subscribeLocale(() => set(getLocale())), []);
  return locale;
}

/** Translate an English UI phrase. */
export function t(key: string): string {
  if (current === "zh") return ZH[key] ?? key;
  return key;
}
