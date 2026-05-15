# 08 - 交互式Agent重构方案

## 1. 目标体验

用户输入："请帮我在根目录实现立方接雨水算法"

**期望的交互流程：**

```
用户: 请帮我在根目录实现立方接雨水算法

💡 CodePilot: 让我先查看项目根目录结构，确认在哪里创建文件。
📂 CodePilot 读取了项目目录:
   - 这是一个 Java Maven 项目
   - 根目录包含: pom.xml, src/, README.md

💡 CodePilot: 我在根目录下创建一个独立的 Java 文件来实现立方接雨水算法（3D Trapping Rain Water，即 LeetCode 407）。
   立方接雨水是二维版本，使用最小堆（优先队列）解法，从边界向内收缩。

📝 CodePilot 想要创建新文件:
   TrapRainWater3D.java  +101行
   [展开查看代码]

⌨️ 验证一下编译和运行是否正确:
   $ javac TrapRainWater3D.java && java TrapRainWater3D
   示例1 → 输出 4 ✓
   示例2 → 输出 10 ✓
   示例3 → 输出 0 ✓

✅ 已在根目录创建 TrapRainWater3D.java，实现了立方接雨水算法。
```

**关键特征：**
1. **声明意图**：每个操作前先说出要做什么、为什么
2. **过程可见**：文件读取、代码编写、命令执行都有中间状态展示
3. **结果确认**：创建/修改文件后展示变更预览，运行命令后展示结果
4. **按需读取**：只在真正需要时才读取文件，而非每次都读

## 2. 当前架构问题

### 2.1 SSE事件过于底层
当前SSE事件（tool_call/tool_result_ack）直接暴露工具调用细节，缺少语义层：
- `tool_call(gather.execute)` → 用户看到"📥 收集 3 个文件"而非"让我先查看项目结构"
- `tool_call(fs.applyPatch)` → 用户看到"🩹 补丁"而非"想要创建新文件: TrapRainWater3D.java +101行"

### 2.2 Action缺少声明阶段
当前Action直接执行，没有"先声明意图，再执行"的两阶段模式：
- PlanningAction：直接输出计划，没有"我正在分析你的需求..."
- GatherAction：直接发出tool_call，没有"让我先查看..."
- GenerateAction：直接生成代码，没有"我准备创建..."
- ApplyPatchAction：直接应用补丁，没有"想要修改以下文件..."

### 2.3 gather.execute语义模糊
`gather.execute`把多个文件读取打包成一个batch工具调用，前端无法展示每个读取的目的和结果。

## 3. 重构方案

### 3.1 新增SSE事件类型

在 `SseEvents` 中新增：

| 事件名 | 用途 | 示例 |
|--------|------|------|
| `agent_thinking` | Agent思考/意图声明 | "让我先查看项目根目录结构" |
| `agent_reading` | 声明式文件读取（替代gather.execute的粗粒度事件） | 递归地查看了该目录中的所有文件 |
| `agent_writing` | 声明式文件变更预览 | 想要创建新文件: TrapRainWater3D.java +101行 |
| `agent_running` | 声明式命令执行 | 验证一下编译和运行是否正确 |

这些事件与现有事件**并行存在**，不替换底层tool_call/tool_result_ack，而是在其之上提供语义层。

### 3.2 Action改造方案

#### PlanningAction
```
Before: 直接调用LLM → 输出plan/infoRequests
After:  emit(agent_thinking, "正在分析你的需求...") → 调用LLM → 输出plan/infoRequests
```

#### GatherAction（重构为声明式读取）
```
Before: emit(tool_call, gather.execute, {requests: [...]}) → 等待tool-result
After:  emit(agent_thinking, "让我先查看项目根目录结构，确认在哪里创建文件")
        → emit(agent_reading, {purpose: "查看项目结构", targets: ["根目录"], result: "Java Maven项目..."})
        → 底层仍然用tool_call执行，但前端优先展示agent_reading语义
```

#### GenerateAction
```
Before: 调用LLM → 输出patches → 路由到applyPatch
After:  emit(agent_thinking, "我在根目录下创建一个独立的Java文件来实现...")
        → 调用LLM → 输出patches
        → emit(agent_writing, {files: [{path, op, lineCount, preview}]})
        → 路由到applyPatch
```

#### ApplyPatchAction
```
Before: emit(tool_call, fs.applyPatch) → 等待tool-result
After:  emit(agent_writing, {files: [...]}) 已在GenerateAction发出
        → emit(tool_call, fs.applyPatch) → 等待tool-result
```

#### VerifyAction / Shell执行
```
Before: 直接执行验证
After:  emit(agent_running, {command: "javac TrapRainWater3D.java && java TrapRainWater3D", purpose: "验证编译和运行"})
        → 执行 → emit结果
```

### 3.3 前端组件改造

#### 新增AgentStepCard组件
统一替代当前的ToolCallCard，支持多种step类型：

```tsx
interface AgentStep {
    type: 'thinking' | 'reading' | 'writing' | 'running' | 'checking';
    content: string;           // 主要描述文本
    status: 'running' | 'success' | 'error';
    detail?: {                 // 展开详情
        files?: FileInfo[];    // 读取/写入的文件列表
        command?: string;      // 执行的命令
        output?: string;       // 命令输出
        diff?: string;         // 代码变更diff
    };
}
```

渲染效果：
- `thinking`: 💡 + content（无展开，灰色背景）
- `reading`: 📂 + content + 展开查看文件内容
- `writing`: 📝 + content + 展开查看代码预览
- `running`: ⌨️ + content + 展开查看命令和输出
- `checking`: 🛡️ + content + 展开查看检查结果

#### ChatView改造
将messages中的toolCalls字段逐步迁移为agentSteps：
```tsx
interface ChatMessage {
    // ... existing fields
    agentSteps?: AgentStep[];  // 新：交互式步骤
    toolCalls?: ToolCallInfo[]; // 旧：保留兼容
}
```

### 3.4 插件端(Kotlin)改造

CefChatPanel的SSE事件处理需要新增：

```kotlin
// ConversationClient.Listener 新增
fun onAgentThinking(payload: JsonNode) {}
fun onAgentReading(payload: JsonNode) {}
fun onAgentWriting(payload: JsonNode) {}
fun onAgentRunning(payload: JsonNode) {}
```

CefChatPanel转发到WebUI：
```kotlin
"agent_thinking" -> {
    dispatchToWeb("agent_thinking", data)
}
// ... 类似
```

### 3.5 实现优先级

**Phase 1（核心交互层）**：
1. 新增4个SSE事件类型（SseEvents + ConversationClient + bridge.ts）
2. 重构GatherAction：发出agent_thinking + agent_reading
3. 重构GenerateAction：发出agent_thinking + agent_writing
4. 新增AgentStepCard组件
5. App.tsx处理新事件

**Phase 2（验证与执行层）**：
6. ApplyPatchAction发出agent_writing（变更预览）
7. VerifyAction/ShellExecutor发出agent_running
8. MultiFileDiffPanel集成到AgentStepCard

**Phase 3（计划与进度层）**：
9. PlanningAction发出agent_thinking
10. plan/update事件用AgentStepCard展示
11. 进度条/阶段指示器

## 4. 数据流

```
后端Action                    SSE事件                    前端展示
──────────                    ────────                    ────────
PlanningAction
  ├─ LLM调用前               agent_thinking              💡 正在分析你的需求...
  └─ LLM调用后               user_plan                   📋 计划展示

GatherAction  
  ├─ 读取前                   agent_thinking              💡 让我先查看项目结构...
  ├─ tool_call(gather)        tool_call                   📂 读取中... (底层)
  ├─ 读取后                   agent_reading               📂 这是一个Java Maven项目...
  └─ tool_result_ack          tool_result_ack             ✓ (底层确认)

GenerateAction
  ├─ LLM调用前               agent_thinking              💡 我将创建一个Java文件...
  ├─ LLM调用后               agent_writing               📝 想要创建: TrapRainWater3D.java +101行
  └─ (展开详情)               (同上, detail字段)           [代码预览]

ApplyPatchAction
  ├─ tool_call(fs.applyPatch) tool_call                   (底层执行)
  └─ tool_result_ack          tool_result_ack             ✓ 已创建

VerifyAction
  ├─ 执行前                   agent_running               ⌨️ 验证编译和运行...
  └─ 执行后                   agent_running(result)       ⌨️ 示例1→4 ✓ 示例2→10 ✓

FinalizeAction
  └─ 完成                     delta + done                ✅ 总结文本
```

## 5. 关键设计决策

### 5.1 agent_*事件与tool_call事件的关系
- **agent_*是语义层**：面向用户的描述性事件
- **tool_call是执行层**：面向工具的实际调用
- 两者**同时发出**，前端优先渲染agent_*，tool_call仅作为状态追踪
- 前端ToolCallCard逐步替换为AgentStepCard，但保留tool_call处理以兼容旧版

### 5.2 agent_thinking的生成方式
- **Action硬编码**：在Action代码中直接emit，根据当前阶段生成固定文本
- **LLM生成**：让LLM在输出JSON中新增thinking字段
- **方案选择**：Phase 1用Action硬编码（可控性强），Phase 2考虑LLM生成（更自然）

### 5.3 agent_reading/agent_writing的内容来源
- agent_reading：GatherAction收到tool-result后，将结果格式化为用户友好的描述
- agent_writing：GenerateAction解析出patches后，将变更摘要格式化展示