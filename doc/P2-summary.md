# P2 阶段总结(2026-05-17)

## 完成情况

- **P2-09 BranchTree / SessionSidebarV2 ✅**:可视化分支树、历史搜索/分组、pin/archive/rename/duplicate,并补齐相关 Kotlin bridge。
- **P2-10 Budget Breakdown / 多模态 ✅**:Context 分桶展示、图片粘贴/拖拽、文件/文件夹拖拽 chip、语音输入入口;后端已补 `/v1/speech/recognize` 和图片 `data:` URI 兼容。
- **P2-11 Model Router / Max / Usage ✅**:Auto/Max UI、模型路由提示、Usage 面板。后端 `/v1/models` 已返回 `tier/capabilities/contextWindow/pricing/source`;`ConversationRunRequest.Policy` 已支持 `thinkingMode/maxOutputTokens/maxMode`。
- **P2-12 Slash / Templates / Notifications ✅**:Slash commands、模板面板、`.codepilot/templates.json` 持久化、桌面通知 + IDE fallback、`@` 中文标点修复。

## 后端与 Prompt 核查

- P2-09/P2-12 主要是插件/WebUI 能力,所需后端由 Kotlin bridge 和本地持久化承接,无需新增 Java API。
- P2-10 图片多模态 Java 后端已有 `ConversationRunRequest.Image` / `ConversationService` 支持,本次补齐 `raw base64` 与 `data:` URI 兼容;语音输入依赖后端 STT,已新增 OpenAI-compatible `/v1/speech/recognize`。
- P2-11 确实需要 Java 后端支持,本次已补齐模型元数据和 Max 策略字段,避免仅靠前端/插件猜测。
- 现有 prompt 模板可承接 P2 功能;P2 没有新增必须的 LLM prompt。Max/thinking 目前作为策略提示进入后端请求契约,具体 provider 原生参数映射可在后续按模型 SDK 细化。

## 验证

- `plugin/webui`: `npm run build` ✅
- `plugin`: `gradle compileKotlin` ✅
- `backend`: `gradle :codePilot-core:compileJava :codePilot-api:compileJava` ✅

## 剩余风险

- **Max / thinking provider 适配**:Max 模式已进入后端 schema,但 Spring AI provider 层是否支持原生 reasoning/thinking 参数仍需按模型适配。短期已可作为路由与预算提示;中期应在 `ChatClientFactory` 按 OpenAI/Anthropic/Gemini 协议映射到真实参数。
- **Usage 持久化**:UsageTracker 当前在插件进程内聚合,重启后不会长期保留历史。若要团队配额、跨设备统计或账单审计,应迁到 Java 后端表并按 user/model/session/day 聚合。
- **Speech provider 可用性**:`/v1/speech/recognize` 已补齐 OpenAI-compatible 接口,但依赖部署环境配置 `codepilot.speech.*` 或 `spring.ai.openai.*`;离线环境仍会回退失败提示。
- **图片模型能力校验**:后端已支持图片 content,但还未在发送前强制校验所选模型 `VISION` capability。当前 Auto 路由会优先选 vision 模型;手选非 vision 模型时 provider 可能报错。
- **本地特性与云同步边界**:P2-09/P2-12 的 pin/archive/templates 目前主要落在插件本地。若要多设备一致性,需要后端 session/template API。
- **进入 P3**:Background Agents、Share/Export、Tab 多行预测将分别补齐隔离执行、会话交付和更强 Tab 体验。
