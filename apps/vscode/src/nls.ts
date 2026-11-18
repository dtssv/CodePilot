// Lightweight IDE-host strings. Keys are English; Chinese follows `vscode.env.language`.

import * as vscode from "vscode";

const ZH: Record<string, string> = {
  "CodePilot: open a file and place the cursor where the code should go.":
    "CodePilot：请先打开文件，并把光标放到要插入代码的位置。",
  "CodePilot: select some code first.": "CodePilot：请先选中一段代码。",
  "CodePilot: open a file first.": "CodePilot：请先打开一个文件。",
  "CodePilot: open a folder in the window, or it will use ~/CodePilot.":
    "CodePilot：请在窗口中打开文件夹；否则将使用 ~/CodePilot。",
  "CodePilot workspace: {0}": "CodePilot 工作区：{0}",
  "CodePilot: Switch Workspace Folder": "CodePilot：切换工作区目录",
  "Select the active folder": "选择当前活动目录",
  "CodePilot: Switch Mode": "CodePilot：切换模式",
  "Select collaboration mode": "选择协作模式",
  "Ask — read-only Q&A": "问答 — 只读提问",
  "Plan — read-only exploration + planning": "规划 — 只读探索与计划",
  "Agent — full autonomous execution": "代理 — 完整自主执行",
  "Ask CodePilot about the selection": "就选中内容询问 CodePilot",
  "What do you want to know?": "你想了解什么？",
  "Explain this code.": "解释这段代码。",
  "Open Settings": "打开设置",
  "CodePilot Settings": "CodePilot 设置",
  "CodePilot could not start the engine: {0}. Install/rebuild the extension (bundled engine) or set `codepilot.cliPath` / `codepilot.serverPath`.":
    "CodePilot 无法启动引擎：{0}。请安装/重新构建扩展（内置引擎），或设置 `codepilot.cliPath` / `codepilot.serverPath`。",
  "CodePilot (busy)": "CodePilot（忙碌）",
  "CodePilot (error)": "CodePilot（错误）",
  "CodePilot (connecting)": "CodePilot（连接中）",
  Ask: "问答",
  Plan: "规划",
  Agent: "代理",
  "CodePilot: Set API Key": "CodePilot：设置 API Key",
  "Select provider": "选择服务商",
  "API key is saved to ~/.codepilot/config.json": "API Key 将保存到 ~/.codepilot/config.json",
  "API key was empty — nothing saved.": "API Key 为空，未保存。",
  "API key saved to ~/.codepilot/config.json ({0})": "API Key 已保存到 ~/.codepilot/config.json（{0}）",
  Anthropic: "Anthropic",
  "OpenAI / compatible": "OpenAI / 兼容",
  "Google Gemini": "Google Gemini",
  "GitHub Copilot": "GitHub Copilot",
  "Azure OpenAI": "Azure OpenAI",
  "Open Releases": "打开发布页",
  "CodePilot: checking extension update…": "CodePilot：正在检查扩展更新…",
  "CodePilot extension update available: {0} → {1}. Download the .vsix from Releases (engine updates are separate: Settings → Updates, or `codepilot update`).":
    "CodePilot 扩展有更新：{0} → {1}。请从 Releases 下载 .vsix（引擎更新另走：设置 → 更新，或 `codepilot update`）。",
  "Extension {0} → {1} available. Engine updates: use CodePilot Settings → Updates or `codepilot update`.":
    "扩展可更新 {0} → {1}。引擎更新请用 CodePilot 设置 → 更新，或 `codepilot update`。",
  "CodePilot extension is up to date ({0}). Engine updates are checked separately in Settings → Updates.":
    "CodePilot 扩展已是最新（{0}）。引擎更新请在设置 → 更新中单独检查。",
  "CodePilot completion needs a lightweight model distinct from your main chat model. Configure `smallModel` (or `completion.model`) — e.g. a local Ollama `qwen2.5-coder`, or a free Groq / Gemini Flash model.":
    "CodePilot 补全需要与主对话不同的轻量模型。请配置 `smallModel`（或 `completion.model`），例如本地 Ollama 的 `qwen2.5-coder`，或免费的 Groq / Gemini Flash。",
};

function isZh(): boolean {
  return (vscode.env.language || "").toLowerCase().startsWith("zh");
}

/** Translate an English host string; `{0}`… placeholders take `args`. */
export function nls(message: string, ...args: Array<string | number>): string {
  let out = isZh() ? (ZH[message] ?? message) : message;
  for (let i = 0; i < args.length; i++) {
    out = out.replace(new RegExp(`\\{${i}\\}`, "g"), String(args[i]));
  }
  return out;
}
