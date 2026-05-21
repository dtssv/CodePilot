# CodePilot

> 一个对标 Cursor 的 JetBrains IDEA AI 编程助手 —— 插件 + 后端 + Skill/MCP 商城。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/Java-21-orange.svg)](https://adoptium.net/)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.3-brightgreen.svg)](https://spring.io/projects/spring-boot)
[![Spring AI](https://img.shields.io/badge/Spring%20AI-1.0-yellowgreen.svg)](https://docs.spring.io/spring-ai/reference/)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.0-purple.svg)](https://kotlinlang.org/)

---

## 这是什么？

CodePilot 让你在 JetBrains IDEA 里拥有类似 Cursor 的 AI 编码体验。它不是一个简单的 ChatGPT 套壳，而是一个**带 Agent 执行引擎**的编程助手：能理解你的项目上下文，规划任务，读写文件，执行命令，验证结果，还能让你一步步审阅它做的每个改动。

整个项目分三块：

- **插件端**（Kotlin）——跑在 IDEA 里，负责 UI、本地工具执行、代码索引、会话管理等
- **WebUI**（React + Vite）——嵌入插件的 JCEF 浏览器，渲染聊天界面和各种面板
- **后端**（Java / Spring Boot + Spring AI）——负责 LLM 调用、Graph 编排引擎、Prompt 拼装、用户鉴权、MCP 商城等

设计文档详见 [`docs/`](docs/) 和 [`doc/`](doc/)。

---

## 功能一览

### Chat & Agent 对话 ✅

和 AI 对话最核心的能力，支持两种模式：

- **Chat 模式**：一问一答，适合快速提问
- **Agent 模式**：AI 自主规划、执行、验证，多轮工具调用，适合复杂任务

后端使用 **StateGraph 编排引擎**（Spring AI Alibaba Graph），节点包括 intake → planning → preCheck → generate → applyPatch → verify → repair → commit → finalize 等，每一步都通过 SSE 实时推送到前端。

<!-- TODO: 截图 — Chat/Agent 对话界面 -->

**待完善：**
- Deep Research 模式（generate → gather → searchEvaluate → synthesize 拓扑已设计，但尚未完全产品化）
- 会话恢复（发版/SSE 硬断场景下的自动续流，设计中）

### 代码变更审阅（Hunk 级 Apply） ✅

AI 生成的代码改动不会直接写盘，而是先进入**暂存区**，你可以按 hunk（代码块）级别逐个 Accept 或 Reject：

- 行级 LCS Diff 对比
- 支持 undoTurn 回退整轮改动
- staging 默认开启，不会意外改你代码

<!-- TODO: 截图 — Hunk 级 Diff 审阅界面 -->

### 内联编辑（Cmd+K / Ctrl+K） ✅

选中代码后按 `Cmd+K`，直接在编辑器里用自然语言描述你想要的修改，AI 会给出 inline diff 预览，确认后应用。

<!-- TODO: 截图 — 内联编辑界面 -->

### Tab 补全 ✅

类似 Copilot 的行内代码补全：

- 多行 ghost text 预测
- 5 维评分 + 智能扩展
- 后端 FIM predict 接口 + 本地启发式混合
- 来源统计（heuristics / fim / model）

<!-- TODO: 截图 — Tab 补全效果 -->

**待完善：**
- 跨文件 edit apply（目前以单文件为主）
- 模型化结构化 edits（当前以本地启发式为主）

### 右键快捷 Action ✅

在编辑器里选中代码，右键可以看到 CodePilot 菜单：

| Action | 快捷键 | 功能 |
|---|---|---|
| Refactor | `Ctrl+Alt+R` | 重构选中代码 |
| Review | `Ctrl+Alt+V` | 代码评审 |
| Comment | `Ctrl+Alt+/` | 生成注释 |
| GenTest | `Ctrl+Alt+T` | 生成测试 |
| GenDoc | `Ctrl+Alt+D` | 生成文档 |
| AddToChat | `Ctrl+L` | 把选中代码加入当前聊天 |
| OpenChat | `Ctrl+Shift+L` | 打开聊天面板 |
| FindBugs | — | Bug 扫描（IDEA Inspections + LLM） |

<!-- TODO: 截图 — 右键菜单 -->

### 代码索引 & 搜索 ✅

纯本地的代码索引，不上传你的代码：

- BM25 + 语义余弦 + 符号 + 路径混合评分
- 支持 `@` 引用将搜索结果加入对话上下文
- 自动索引 + pause / resume / rebuild 控制
- 上下文预算条，实时显示 token 用量

<!-- TODO: 截图 — 代码索引面板 + @引用 -->

### Rules & Memories ✅

告诉 AI 你的项目规矩和重要记忆：

- **Rules**：项目级 `.codepilot/rules.md` 或全局规则，自动注入 system prompt
- **Memories**：AI 在对话中可以提取和记住重要事实，有待审队列让你确认
- 规则加载状态 pill 显示

<!-- TODO: 截图 — Rules & Memories 面板 -->

### MCP 集成 ✅

支持 Model Context Protocol，连接外部工具和数据源：

- MCP Server 管理面板（start / stop / reload / 配置编辑）
- Graph 运行时 `mcp.call` 执行外部工具
- 执行前确认门（McpConfirmGate），防止危险操作
- Hooks 机制：`beforeSubmitPrompt` / `beforeShellExecution`

<!-- TODO: 截图 — MCP 面板 + 确认对话框 -->

**待完善：**
- MCP Hub 对话内深度集成（商城 CRUD 已实现，但与对话内工具治理 UI 仍分离）

### Shell 命令执行 ✅

让 AI 帮你跑命令，但你说了算：

- Shell 允许名单策略（ShellPolicy）
- 流式输出实时展示（ShellStepCard）
- 执行前确认 + Hooks 拦截
- 只读模式保护

<!-- TODO: 截图 — Shell 命令执行 + 确认条 -->

### 模型路由 & Max 模式 ✅

- 多模型切换，支持 Auto / 手动选择
- Max 模式（更强但更贵）
- Thinking 模式（o-series reasoning + Claude thinking）
- 后端 `/v1/models` 返回 tier / capabilities / contextWindow / pricing
- 每轮 token / 费用脚标

<!-- TODO: 截图 — 模型选择器 + Max 模式提示 -->

**待完善：**
- Max/thinking 的 provider 原生参数适配（当前作为策略提示，未完全映射到各 provider 协议）

### 会话管理 ✅

- 分支式会话树（BranchTimeline），可以切换分支
- 历史 Session 搜索 / 分组 / pin / archive / rename / duplicate
- 本地 NDJSON 持久化（events + messages + plan + checkpoint）
- 会话导出 & 分享

<!-- TODO: 截图 — 分支树 + 历史面板 -->

### Background Agents ✅

让 AI 在后台跑任务：

- 独立 git worktree 隔离执行
- 任务列表 / 取消 / 打开 worktree
- 云端同步（JDBC 持久化）
- Squash merge / discard

<!-- TODO: 截图 — Background Agents 面板 -->

**待完善：**
- ToolDispatcher 的 workspace override（工具执行未完全切到 worktree 根目录）

### Share & Export ✅

- Markdown / PR Description / JSON 格式导出
- 本地分享 + 云端分享（JDBC 持久化）
- 脱敏摘要

<!-- TODO: 截图 — Export 面板 -->

**待完善：**
- 公网可访问分享链接（当前是本地 file URL）

### Slash Commands & Templates ✅

- 输入 `/` 触发命令列表
- 自定义模板（`.codepilot/templates.json`）
- 桌面通知 + IDE fallback

<!-- TODO: 截图 — Slash 命令弹窗 -->

### 语音输入 ✅

- 语音输入入口
- 后端 OpenAI-compatible STT 接口（`/v1/speech/recognize`）

**待完善：**
- 语音服务依赖部署环境配置，离线环境会回退失败

### 图片多模态 ✅

- 图片粘贴 / 拖拽到对话
- 文件 / 文件夹拖拽生成上下文 chip
- 后端支持图片 content（base64 / data: URI）

<!-- TODO: 截图 — 图片拖拽到对话 -->

**待完善：**
- 发送前强制校验模型 VISION capability（当前 Auto 路由会优先选 vision 模型，但手选非 vision 模型时可能报错）

### Git Commit Message 生成 ✅

- 自动分析 staged changes 生成 commit message
- 右键菜单触发

### 热更新 ✅

- HotPatchService 运行时资源更新
- 插件更新检查
- 回滚机制

### Skill / MCP 商城

后端 MCP Hub 模块（`codePilot-mcp-hub`）已实现 CRUD 和安装记录，插件端有 `MarketplacePanel` 和 `ThirdPartyRegistryClient`，但商城与对话内工具治理的深度整合还在进行中。

<!-- TODO: 截图 — 商城面板 -->

**待完善：**
- 商城与对话的深度闭环（安装 → 激活 → 对话中使用 → 评价）
- 第三方 Registry 的完整 E2E 验证

---

## 怎么用？

### 快速上手

1. 启动后端服务（见下方构建说明）
2. 在 IDEA 安装 CodePilot 插件
3. 打开右侧 CodePilot 工具窗口
4. 登录（Dev 模式 / OIDC / 企业 SSO）
5. 开始对话！

### 几个常用姿势

- **想问问题**：直接在聊天框输入，Chat 模式一问一答
- **想让 AI 干活**：切换到 Agent 模式，描述你的需求，AI 会规划执行
- **想改代码**：选中代码 → `Cmd+K`，用自然语言描述修改
- **想补全代码**：正常敲代码，AI 会自动给出补全建议，Tab 接受
- **想加上下文**：用 `@` 引用文件/符号/代码，或直接拖拽文件到聊天框
- **想定规矩**：在项目根目录创建 `.codepilot/rules.md`，写上你的项目规范

---

## 构建 & 运行

### 后端（本地开发）

```bash
# 1) 启动依赖服务
docker compose -f scripts/deploy/docker-compose.dev.yml up -d

# 2) 配置环境变量
cp backend/.env.example backend/.env
# 编辑 .env 填入你的配置

# 3) 启动后端
cd backend
./gradlew :codePilot-bootstrap:bootRun
# 默认监听 :8080，OpenAPI: http://localhost:8080/swagger-ui.html
```

### 插件（本地开发）

```bash
cd plugin

# 启动带插件的 IntelliJ 沙箱
./gradlew runIde

# 构建插件分发包
./gradlew buildPlugin
# 产出 build/distributions/codePilot-*.zip
```

### 数据库

所有变更只通过 `scripts/db/V*.sql` 修改，启动时由 Flyway 自动应用。

### 部署

完整的部署说明（裸机 / Docker Compose / Kubernetes）详见 [**DEPLOY.md**](DEPLOY.md)。

---

## 配置

后端通过环境变量配置，缺失关键变量会导致启动失败：

| 变量 | 说明 | 必填 |
|---|---|---|
| `CODEPILOT_DB_URL` | Postgres JDBC URL | ✓ |
| `CODEPILOT_DB_USER` / `CODEPILOT_DB_PASSWORD` | DB 凭据 | ✓ |
| `CODEPILOT_REDIS_URL` | Redis URL | ✓ |
| `CODEPILOT_LLM_BASE_URL` | LLM 上游地址（OpenAI 协议） | ✓ |
| `CODEPILOT_LLM_API_KEY` | LLM ApiKey | ✓ |
| `CODEPILOT_LLM_DEFAULT_MODEL` | 默认模型 | ✓ |
| `CODEPILOT_JWT_SECRET` | JWT 签名密钥（≥32 字节） | ✓ |
| `CODEPILOT_HMAC_SECRET` | 设备 HMAC 密钥 | ✓ |

复制 `backend/.env.example` 后填值即可。更多可选参数见 [DEPLOY.md](DEPLOY.md)。

---

## 安全

- 后端**不持久化**用户会话或代码内容，仅保留 hash + 元数据审计
- System Skill 永远驻后端，不下发给客户端，`SystemPromptLeakFilter` 双向检测
- 用户的 Skill / MCP 配置仅本地存储
- JWT + HMAC 双层鉴权，时间戳 + nonce 防重放
- 所有上行内容正则脱敏，模型输出做代码注入 / 凭证 / PII / 系统提示词外泄扫描

---

## 项目状态

当前 P0-P3 阶段已基本完成，主链路稳定可用。详细的成熟度矩阵见 [`doc/STATUS.md`](doc/STATUS.md)，差距分析见 [`doc/gap-analysis-report.md`](doc/gap-analysis-report.md)。

---

## 文档索引

- [架构设计](docs/01-架构设计.md)
- [插件端设计](docs/02-插件端设计.md)
- [后端设计](docs/03-后端设计.md)
- [Prompt 模板](docs/04-Prompt模板.md)
- [接口文档](docs/05-接口文档.md)
- [Graph 编排方案](docs/06-Graph编排方案.md)
- [部署手册](DEPLOY.md)
- [对标 Cursor 路线图](doc/16-对标Cursor路线图.md)
- [能力成熟度矩阵](doc/STATUS.md)

---

## 开发约定

- **不允许 mock**：开发与测试都使用真实组件，CI 用 Testcontainers
- **统一日志**：JSON Logback，trace 透传
- **代码风格**：Java 用 Spotless + Google Java Format，Kotlin 用 ktlint
- **提交规范**：Conventional Commits（`feat:` / `fix:` / `docs:`）

---

## 许可

[MIT](LICENSE)