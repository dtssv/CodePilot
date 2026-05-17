# 01 — 事件协议与状态机重构(P0)

> **实现状态:✅ 已完成(灰度上线)**
>
> 落地文件:
> - `plugin/src/main/kotlin/io/codepilot/plugin/protocol/EventEnvelope.kt`
> - `plugin/src/main/kotlin/io/codepilot/plugin/protocol/EventBus.kt`
> - `plugin/src/main/kotlin/io/codepilot/plugin/protocol/LegacyEventAdapter.kt`
> - `plugin/webui/src/state/events.ts`
> - `plugin/webui/src/state/turnReducer.ts`(含 5 项自检全部通过)
> - `plugin/webui/src/state/chatStore.ts`
> - `plugin/webui/src/state/turnReducer.test.ts`
>
> 集成点:`plugin/src/main/kotlin/io/codepilot/plugin/toolwindow/CefChatPanel.kt`
> 在 init 阶段 setDispatcher,在 `handleUserMessage` 里创建 LegacyEventAdapter,
> 在 SSE listener 各回调里**附加**调用 adapter(不替换 legacy dispatchToWeb)。
> 同时支持 Web → Plugin 的 `replay_since { lastSeq }` 端点。
>
> 灰度方式:WebUI 通过 `localStorage['codepilot.protocol.v2'] === '1'` 启用
> v2 store;否则现有 UI 完全不受影响。
>
> 自检通过:`cd plugin/webui && npx tsx src/state/turnReducer.test.ts`
> - happy path / 重复 seq 忽略 / 乱序补包 / 未知 step 容错 / 终态粘滞

## 1. 目标

替换 `App.tsx` 中靠 `activeReplyRef` + `activeTurnIdRef` + `upsertTurnAssistant`
拼装会话的方式。改由后端推送**结构化、可重放、带 seq 的事件流**,前端做纯渲染。

## 2. 现状问题(精确定位)

- `App.tsx:271-293` `done` 事件的 reason 字符串硬编码;新增任意 reason 会破坏行为。
- `App.tsx:251-258` `user_message_saved` 用 `activeReplyRef` 去重,事件乱序时丢消息。
- `App.tsx:97-101` 两个 ref 既是逻辑闸门又是数据载体,切会话/切分支时极易污染。
- `agent_thinking/reading/writing/running` 的"前一步置为 success"启发式
  (`App.tsx:523-566`) 会掩盖真实失败。
- 缺失 seq 号,无法乱序、重连、补包。

## 3. 协议设计

### 3.1 三元主键

每个事件必须携带:

```ts
interface EventEnvelope {
  seq: number;          // 单调递增,全局唯一(plugin 进程内)
  turnId: string;       // 一次 user_send 引发的全部活动归属
  stepId: string;       // turn 下的一段原子工作(LLM 一轮 / 一次工具调用)
  parentStepId?: string;// 子 step(嵌套工具或子任务)
  ts: number;           // epoch ms
  type: EventType;
  payload: unknown;
}
```

### 3.2 事件类型(替换现有散列事件)

```ts
type EventType =
  // turn 生命周期
  | 'turn.start'      // payload: { turnId, userMessage, contextRefs }
  | 'turn.end'        // payload: { turnId, status: 'final'|'failed'|'stopped'|'interrupted', reason? }

  // step 生命周期(替代 agent_thinking/reading/writing/running)
  | 'step.start'      // payload: { stepId, kind: StepKind, title, parentStepId? }
  | 'step.progress'   // payload: { stepId, detail }
  | 'step.end'        // payload: { stepId, status: 'success'|'error'|'cancelled', error? }

  // 文本流(归属 stepId)
  | 'text.delta'      // payload: { stepId, text }
  | 'text.thinking'   // payload: { stepId, text } 推理流(可选,UI 折叠展示)

  // 工具调用(stepId 自身就是工具 step)
  | 'tool.call'       // payload: { stepId, tool, args }
  | 'tool.progress'   // payload: { stepId, partial }
  | 'tool.result'     // payload: { stepId, ok, result?, error? }

  // 计划
  | 'plan.update'     // payload: { stepId, steps: PlanStep[] }

  // 用户交互
  | 'needs_input'     // payload: { stepId, questions, continuationToken }
  | 'risk_notice'     // payload: { stepId, level, message, files }

  // 会话外事件
  | 'context.added' | 'context.budget'
  | 'session.list' | 'session.switched' | 'session.messages'
  | 'cost.update'
  | 'auth.state' | 'models.loaded' | 'ide.theme';

type StepKind =
  | 'llm'         // LLM 推理(产出 text.delta)
  | 'thinking'    // 思考(产出 text.thinking)
  | 'tool'        // 工具调用
  | 'plan'        // 计划生成
  | 'subtask';    // 多阶段任务分组
```

### 3.3 客户端补包接口

```ts
// Web → Plugin
sendToPlugin('replay_since', { sessionId, lastSeq })
// Plugin 重发 [lastSeq+1, current] 范围内的事件
```

## 4. 前端实现

### 4.1 类型与 store

`plugin/webui/src/state/events.ts`:

```ts
export interface PlanStep { id: string; title: string; status: 'pending'|'running'|'success'|'error'; }

export interface StepNode {
  stepId: string;
  parentStepId?: string;
  kind: StepKind;
  title: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  startedAt: number;
  endedAt?: number;

  // 内容载体(按 kind 不同 only 其一有意义)
  textBuf: string;        // llm
  thinkingBuf: string;    // thinking
  toolCall?: { tool: string; args: unknown };
  toolResult?: { ok: boolean; result?: unknown; error?: string };
  plan?: PlanStep[];
  progressDetail?: unknown;

  children: string[];     // 子 stepId
}

export interface TurnNode {
  turnId: string;
  userMessage: string;
  contextRefs: { display: string; type?: string }[];
  status: 'running' | 'final' | 'failed' | 'stopped' | 'interrupted';
  rootStepIds: string[];
  stepIds: string[];      // 完整顺序(渲染用)
  startedAt: number;
  endedAt?: number;
}

export interface ChatState {
  turns: TurnNode[];
  steps: Record<string, StepNode>;
  lastSeq: number;
  // 其余:auth/session/models/cost...
}
```

`plugin/webui/src/state/turnReducer.ts`:

```ts
import type { EventEnvelope, ChatState, StepNode, TurnNode } from './events';

export function reduce(state: ChatState, ev: EventEnvelope): ChatState {
  // 1) 顺序保护:旧 seq 直接丢弃
  if (ev.seq <= state.lastSeq) return state;
  // 2) gap 检测:由调用方负责触发 replay_since
  const next: ChatState = { ...state, lastSeq: ev.seq };

  switch (ev.type) {
    case 'turn.start': {
      const p = ev.payload as { userMessage: string; contextRefs?: any[] };
      const turn: TurnNode = {
        turnId: ev.turnId,
        userMessage: p.userMessage,
        contextRefs: p.contextRefs || [],
        status: 'running',
        rootStepIds: [],
        stepIds: [],
        startedAt: ev.ts,
      };
      return { ...next, turns: [...state.turns, turn] };
    }

    case 'turn.end': {
      const p = ev.payload as { status: TurnNode['status'] };
      return {
        ...next,
        turns: state.turns.map(t =>
          t.turnId === ev.turnId ? { ...t, status: p.status, endedAt: ev.ts } : t),
      };
    }

    case 'step.start': {
      const p = ev.payload as { stepId: string; kind: StepNode['kind']; title: string; parentStepId?: string };
      const step: StepNode = {
        stepId: p.stepId,
        parentStepId: p.parentStepId,
        kind: p.kind,
        title: p.title,
        status: 'running',
        startedAt: ev.ts,
        textBuf: '',
        thinkingBuf: '',
        children: [],
      };
      const steps = { ...state.steps, [p.stepId]: step };
      // attach to parent or turn root
      if (p.parentStepId && steps[p.parentStepId]) {
        steps[p.parentStepId] = {
          ...steps[p.parentStepId],
          children: [...steps[p.parentStepId].children, p.stepId],
        };
      }
      const turns = state.turns.map(t => {
        if (t.turnId !== ev.turnId) return t;
        return {
          ...t,
          rootStepIds: p.parentStepId ? t.rootStepIds : [...t.rootStepIds, p.stepId],
          stepIds: [...t.stepIds, p.stepId],
        };
      });
      return { ...next, steps, turns };
    }

    case 'step.end': {
      const p = ev.payload as { stepId: string; status: StepNode['status']; error?: string };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return {
        ...next,
        steps: { ...state.steps, [p.stepId]: { ...cur, status: p.status, endedAt: ev.ts } },
      };
    }

    case 'text.delta': {
      const p = ev.payload as { stepId: string; text: string };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return { ...next, steps: { ...state.steps, [p.stepId]: { ...cur, textBuf: cur.textBuf + p.text } } };
    }

    case 'text.thinking': {
      const p = ev.payload as { stepId: string; text: string };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return { ...next, steps: { ...state.steps, [p.stepId]: { ...cur, thinkingBuf: cur.thinkingBuf + p.text } } };
    }

    case 'tool.call': {
      const p = ev.payload as { stepId: string; tool: string; args: unknown };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return { ...next, steps: { ...state.steps, [p.stepId]: { ...cur, toolCall: { tool: p.tool, args: p.args } } } };
    }

    case 'tool.progress': {
      const p = ev.payload as { stepId: string; partial: unknown };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return { ...next, steps: { ...state.steps, [p.stepId]: { ...cur, progressDetail: p.partial } } };
    }

    case 'tool.result': {
      const p = ev.payload as { stepId: string; ok: boolean; result?: unknown; error?: string };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return {
        ...next,
        steps: {
          ...state.steps,
          [p.stepId]: {
            ...cur,
            toolResult: { ok: p.ok, result: p.result, error: p.error },
            status: p.ok ? 'success' : 'error',
            endedAt: ev.ts,
          },
        },
      };
    }

    case 'plan.update': {
      const p = ev.payload as { stepId: string; steps: PlanStep[] };
      const cur = state.steps[p.stepId];
      if (!cur) return next;
      return { ...next, steps: { ...state.steps, [p.stepId]: { ...cur, plan: p.steps } } };
    }

    default:
      return next;
  }
}
```

### 4.2 dispatcher 与 gap 检测

`plugin/webui/src/state/sessionStore.ts`(用 zustand,如不引入新依赖,可改为
`useReducer` + Context,逻辑一致):

```ts
import { create } from 'zustand';
import { reduce } from './turnReducer';
import { onPluginEvent, sendToPlugin } from '../bridge';
import type { EventEnvelope, ChatState } from './events';

const initial: ChatState = { turns: [], steps: {}, lastSeq: 0 };

export const useChatStore = create<ChatState & {
  apply: (ev: EventEnvelope) => void;
  reset: () => void;
}>((set, get) => ({
  ...initial,
  apply: (ev) => {
    const cur = get();
    // gap 检测:期望 lastSeq+1,若跳跃则补包后再 apply
    if (cur.lastSeq > 0 && ev.seq > cur.lastSeq + 1) {
      const fromSeq = cur.lastSeq;
      // 缓存当前 ev,等补包结束后由 plugin 重放它
      pendingBuffer.push(ev);
      sendToPlugin('replay_since', { lastSeq: fromSeq }).catch(() => {});
      return;
    }
    set(reduce(cur, ev));
    flushPending(get, set);
  },
  reset: () => set(initial),
}));

const pendingBuffer: EventEnvelope[] = [];
function flushPending(get: () => ChatState, set: (s: Partial<ChatState>) => void) {
  pendingBuffer.sort((a, b) => a.seq - b.seq);
  while (pendingBuffer.length && pendingBuffer[0].seq <= get().lastSeq + 1) {
    const ev = pendingBuffer.shift()!;
    if (ev.seq <= get().lastSeq) continue;
    set(reduce(get(), ev));
  }
}

// 注册到 bridge:plugin 端把所有结构化事件统一打到 'envelope'
onPluginEvent('envelope', (payload) => {
  useChatStore.getState().apply(payload as EventEnvelope);
});
```

### 4.3 App.tsx 改造

完全删除:

- `activeReplyRef`、`activeTurnIdRef`、`upsertTurnAssistant`
- 14 个分散的 `onPluginEvent('delta' | 'tool_call' | ...)` 注册
- `user_message_saved` 去重逻辑

替换为:

```tsx
const turns = useChatStore(s => s.turns);
const steps = useChatStore(s => s.steps);

const handleSend = async (text: string, chips: ContextChipData[], images?: ImageData[]) => {
  await sendToPlugin('user_message', { text, contextRefs: toRefs(chips), images, mode, modelId });
  // 不再本地插入消息,等 turn.start envelope 回来再渲染
};

<ChatView turns={turns} steps={steps} />
```

`ChatView` 内按 `turn.stepIds` 顺序遍历 `steps[stepId]`,每个 step 用对应的卡片
组件渲染。

## 5. Kotlin 后端

### 5.1 数据类

`plugin/src/main/kotlin/io/codepilot/plugin/protocol/Event.kt`:

```kotlin
package io.codepilot.plugin.protocol

import com.google.gson.JsonElement

data class EventEnvelope(
  val seq: Long,
  val turnId: String,
  val stepId: String,
  val parentStepId: String? = null,
  val ts: Long,
  val type: String,
  val payload: JsonElement,
)

enum class StepKind { LLM, THINKING, TOOL, PLAN, SUBTASK }
enum class TurnStatus { RUNNING, FINAL, FAILED, STOPPED, INTERRUPTED }
enum class StepStatus { RUNNING, SUCCESS, ERROR, CANCELLED }
```

### 5.2 EventBus

```kotlin
package io.codepilot.plugin.protocol

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.google.gson.Gson
import com.google.gson.JsonElement
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.ConcurrentLinkedDeque

@Service(Service.Level.PROJECT)
class EventBus(private val project: Project) {
  private val seq = AtomicLong(0)
  private val buffer = ConcurrentLinkedDeque<EventEnvelope>()
  private val maxBuffer = 5000
  private val gson = Gson()

  fun next(): Long = seq.incrementAndGet()

  fun emit(turnId: String, stepId: String, type: String, payload: Any,
           parentStepId: String? = null): EventEnvelope {
    val env = EventEnvelope(
      seq = next(), turnId = turnId, stepId = stepId, parentStepId = parentStepId,
      ts = System.currentTimeMillis(), type = type,
      payload = gson.toJsonTree(payload),
    )
    pushBuffer(env)
    dispatch(env)
    return env
  }

  fun replaySince(lastSeq: Long): List<EventEnvelope> =
    buffer.filter { it.seq > lastSeq }.sortedBy { it.seq }

  private fun pushBuffer(env: EventEnvelope) {
    buffer.addLast(env)
    while (buffer.size > maxBuffer) buffer.pollFirst()
  }

  private fun dispatch(env: EventEnvelope) {
    // 推到 WebUI:统一只调用 __codepilot_dispatch('envelope', env)
    CefBridge.getInstance(project).dispatch("envelope", gson.toJson(env))
  }
}
```

### 5.3 ConversationClient 改造

定位:`plugin/src/main/kotlin/io/codepilot/plugin/conversation/ConversationClient.kt`。
原本散发 14 种事件,改为统一通过 `EventBus.emit`:

```kotlin
class ConversationClient(private val project: Project) {
  private val bus = project.getService(EventBus::class.java)

  fun userMessage(req: UserMessageRequest) {
    val turnId = "turn-${System.nanoTime()}"
    bus.emit(turnId, turnId, "turn.start", mapOf(
      "userMessage" to req.text,
      "contextRefs" to req.contextRefs,
    ))

    // LLM step
    val llmStep = "${turnId}-llm-1"
    bus.emit(turnId, llmStep, "step.start",
      mapOf("stepId" to llmStep, "kind" to "llm", "title" to "Reasoning"))

    sse.stream(req).collect { chunk ->
      when (chunk) {
        is SseChunk.TextDelta -> bus.emit(turnId, llmStep, "text.delta",
          mapOf("stepId" to llmStep, "text" to chunk.text))

        is SseChunk.ToolCall -> {
          val toolStep = "${turnId}-tool-${chunk.id}"
          bus.emit(turnId, toolStep, "step.start",
            mapOf("stepId" to toolStep, "kind" to "tool", "title" to chunk.name),
            parentStepId = llmStep)
          bus.emit(turnId, toolStep, "tool.call",
            mapOf("stepId" to toolStep, "tool" to chunk.name, "args" to chunk.args))
          val result = ToolDispatcher.dispatch(chunk) { partial ->
            bus.emit(turnId, toolStep, "tool.progress",
              mapOf("stepId" to toolStep, "partial" to partial))
          }
          bus.emit(turnId, toolStep, "tool.result",
            mapOf("stepId" to toolStep, "ok" to result.ok,
                  "result" to result.payload, "error" to result.error))
        }

        is SseChunk.Done -> {
          bus.emit(turnId, llmStep, "step.end",
            mapOf("stepId" to llmStep, "status" to "success"))
          bus.emit(turnId, turnId, "turn.end",
            mapOf("turnId" to turnId, "status" to chunk.reason.toTurnStatus()))
        }
      }
    }
  }
}
```

### 5.4 replay 端点

`CefBridge` 注册 `replay_since` 处理:

```kotlin
"replay_since" -> {
  val lastSeq = payload.get("lastSeq").asLong
  bus.replaySince(lastSeq).forEach {
    dispatch("envelope", gson.toJson(it))
  }
}
```

## 6. 兼容期(灰度)

迁移期保留旧 14 个事件,但 Kotlin 端**同时**发 `envelope`,前端通过 feature
flag(`localStorage['codepilot.protocol.v2'] === '1'`)切换:

```ts
const V2 = localStorage.getItem('codepilot.protocol.v2') === '1';
if (V2) {
  onPluginEvent('envelope', ev => useChatStore.getState().apply(ev as any));
} else {
  // 旧 App.tsx 监听
}
```

灰度 1 周稳定后删除旧分支。

## 7. 测试

- 单测 `turnReducer.test.ts`:覆盖每种事件、乱序、重复 seq、未知 stepId。
- 端到端:在 `ConsolePanel` 启动事件录制 → 保存为 `.events.json` → 通过
  `replay_from_file` 在 dev 模式注入,验证 UI 完全等价。
- 故障注入:每 N 个事件随机延迟/丢弃,验证 `replay_since` 收敛。
