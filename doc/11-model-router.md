# 11 — 模型 Auto 路由、Max 模式与 Usage 仪表盘(P2)

> ✅ Completed(2026-05-17):WebUI 已支持 `Auto`、`Max` 和 Usage 面板;插件
> `CefChatPanel` 已做 Auto 路由与 usage 聚合。后端 Java 已补齐
> `/v1/models` 的 `tier/capabilities/contextWindow/pricing/source` 元数据,
> 并在 `ConversationRunRequest.Policy` 增加 `thinkingMode/maxOutputTokens/maxMode`
> 以承载 Max 请求提示。

## 1. 目标

- 提供 **Auto 模式**:按任务类型自动选模型(fast / thinking / agent / inline)。
- 提供 **Max 模式**:对单次请求强制大上下文 + thinking。
- **Usage 仪表盘**:fast/slow/premium 用量、按模型/按会话/按天聚合。

## 2. 现状

- `ModelSelector.tsx` 让用户手选具体模型。
- `SessionCostPanel` 只有总成本,无按模型 breakdown,无配额展示。

## 3. 模型分类

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/conversation/ModelCatalog.kt
data class ModelEntry(
  val id: String,
  val name: String,
  val source: String,              // system | custom
  val tier: Tier,                  // FAST | DEFAULT | THINKING | PREMIUM
  val capabilities: Set<Capability>,
  val contextWindow: Int,
  val pricing: Pricing,            // 每 1M token in/out 单价(美元)
)
enum class Tier { FAST, DEFAULT, THINKING, PREMIUM }
enum class Capability { TEXT, VISION, TOOL_USE, JSON_MODE, LONG_CTX_256K, LONG_CTX_1M }
data class Pricing(val inputPerM: Double, val outputPerM: Double)
```

后端启动时从 `models_loaded` 数据合并默认能力清单(写在
`resources/model-catalog.json`),用户可覆盖。

## 4. Auto 路由

`plugin/src/main/kotlin/io/codepilot/plugin/conversation/ModelRouter.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class ModelRouter(private val project: Project) {
  data class RouteHint(val tier: Tier, val needsVision: Boolean, val needsLongCtx: Boolean,
                       val reason: String)

  fun decide(req: UserMessageRequest, breakdown: BudgetBreakdown): ModelEntry {
    val hint = inferHint(req, breakdown)
    val all = ModelCatalog.list()
    val candidates = all.filter { m ->
      (!hint.needsVision || Capability.VISION in m.capabilities) &&
      m.contextWindow >= breakdown.used + breakdown.estimated &&
      m.tier == hint.tier
    }.ifEmpty { all.filter { it.tier == Tier.DEFAULT } }
    val chosen = candidates.minByOrNull { it.pricing.inputPerM + it.pricing.outputPerM }
      ?: all.first()
    bus.emit("system", "route-${System.nanoTime()}", "model.routed",
      mapOf("modelId" to chosen.id, "tier" to chosen.tier.name, "reason" to hint.reason))
    return chosen
  }

  private fun inferHint(req: UserMessageRequest, b: BudgetBreakdown): RouteHint {
    val text = req.text.lowercase()
    val needsVision = req.images.isNotEmpty()
    val needsLong = b.used + b.estimated > 32_000

    // 启发式优先级:max > inline > agent_tool_chain > heavy_reason > default
    if (req.maxMode) return RouteHint(Tier.PREMIUM, needsVision, true, "user max mode")
    if (req.mode == "inline-edit") return RouteHint(Tier.FAST, false, false, "inline edit")
    if (req.mode == "agent" && req.contextRefs.any { it.type == "codebase" })
      return RouteHint(Tier.THINKING, needsVision, needsLong, "agent + codebase")
    if (HEAVY_KEYWORDS.any { it in text })
      return RouteHint(Tier.THINKING, needsVision, needsLong, "heavy keyword")
    if (text.length < 80 && b.used < 8000)
      return RouteHint(Tier.FAST, needsVision, false, "short prompt")
    return RouteHint(Tier.DEFAULT, needsVision, needsLong, "default")
  }

  private val HEAVY_KEYWORDS = setOf("设计", "重构", "架构", "design", "refactor",
    "explain", "trace", "证明", "优化", "performance")
}
```

`ConversationClient.userMessage` 在 `selectedModelId == "auto"` 时调
`ModelRouter.decide`。

## 5. Max 模式

UI 在 `InputBar` 加 `Max` 切换;开启后:

- 路由结果强制 PREMIUM + 最长 context window
- 后端 `SseRequest` 加 `thinking_mode = "high"`、`max_output_tokens` 解锁上限
- 成本面板高亮该次为 max

```tsx
<label className="max-mode-toggle">
  <input type="checkbox" checked={maxMode} onChange={e => setMaxMode(e.target.checked)} />
  Max
</label>
```

`handleSend` 中 `msgPayload.maxMode = maxMode`。

## 6. ModelSelector 升级

```tsx
export function ModelSelectorV2({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const models = useChatStore(s => s.models);
  const lastRoute = useChatStore(s => s.lastRoutedModel);

  return (
    <select value={value} onChange={e => onChange(e.target.value)} className="model-selector">
      <option value="auto">
        Auto{lastRoute ? ` → ${lastRoute.name}` : ''}
      </option>
      <optgroup label="Fast">
        {models.filter(m => m.tier === 'FAST').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
      <optgroup label="Default">
        {models.filter(m => m.tier === 'DEFAULT').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
      <optgroup label="Thinking">
        {models.filter(m => m.tier === 'THINKING').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
      <optgroup label="Premium">
        {models.filter(m => m.tier === 'PREMIUM').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
    </select>
  );
}
```

## 7. Usage 仪表盘

### 7.1 后端

`plugin/src/main/kotlin/io/codepilot/plugin/usage/UsageTracker.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class UsageTracker(private val project: Project) {
  data class Record(val ts: Long, val sessionId: String, val turnId: String,
                    val modelId: String, val tier: String,
                    val inputTokens: Int, val outputTokens: Int, val costUsd: Double)
  private val records = CopyOnWriteArrayList<Record>()
  private val store = Path.of(project.basePath!!, ".codepilot", "usage.jsonl")

  fun record(r: Record) {
    records.add(r)
    Files.writeString(store, Gson().toJson(r) + "\n",
      StandardOpenOption.CREATE, StandardOpenOption.APPEND)
    emit()
  }

  fun aggregate(byDay: Boolean = true): Map<String, AggBucket> {
    return records.groupBy {
      if (byDay) DateFormatter.day(it.ts) else it.modelId
    }.mapValues { (_, list) ->
      AggBucket(
        inputTokens = list.sumOf { it.inputTokens },
        outputTokens = list.sumOf { it.outputTokens },
        costUsd = list.sumOf { it.costUsd },
        count = list.size,
      )
    }
  }
  data class AggBucket(val inputTokens: Int, val outputTokens: Int,
                       val costUsd: Double, val count: Int)

  private fun emit() = bus.emit("system", "usage", "usage.update",
    mapOf("byDay" to aggregate(true), "byModel" to aggregate(false)))
}
```

`ConversationClient` 在 `turn.end` 时调 `UsageTracker.record`。

### 7.2 UsagePanel

```tsx
export function UsagePanel() {
  const usage = useChatStore(s => s.usage);
  return (
    <div className="usage-panel">
      <h3>用量</h3>

      <div className="usage-grid">
        <Card title="今日成本"  value={`$${todayCost(usage)}`} />
        <Card title="今日 tokens" value={fmtNum(todayTokens(usage))} />
        <Card title="本月成本"  value={`$${monthCost(usage)}`} />
      </div>

      <h4>按模型</h4>
      <table>
        <thead><tr><th>模型</th><th>请求</th><th>Input</th><th>Output</th><th>成本</th></tr></thead>
        <tbody>
          {Object.entries(usage.byModel).map(([m, v]) => (
            <tr key={m}>
              <td>{m}</td>
              <td>{v.count}</td>
              <td>{fmtNum(v.inputTokens)}</td>
              <td>{fmtNum(v.outputTokens)}</td>
              <td>${v.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>近 30 天</h4>
      <SparklineChart data={Object.entries(usage.byDay).slice(-30).map(([d, v]) => ({ d, cost: v.costUsd }))} />
    </div>
  );
}
```

`SparklineChart` 用纯 SVG 实现,无额外依赖:

```tsx
function SparklineChart({ data }: { data: { d: string; cost: number }[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map(d => d.cost), 0.0001);
  const w = 480, h = 80, step = w / Math.max(1, data.length - 1);
  const points = data.map((d, i) => `${i * step},${h - (d.cost / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="sparkline">
      <polyline points={points} fill="none" stroke="#5b8def" strokeWidth={2} />
      {data.map((d, i) => (
        <circle key={i} cx={i * step} cy={h - (d.cost / max) * h} r={2}>
          <title>{d.d}: ${d.cost.toFixed(4)}</title>
        </circle>
      ))}
    </svg>
  );
}
```

## 8. 配额提醒

后端记录每个用户的硬配额(读自 `auth.state` payload 中 `quota`),在 turn 开始
前比对:剩余 < 10% → emit `quota.warn`,前端在顶栏显示警告;剩余 0 → 阻断
并提示充值/降级路由。

## 9. 验收

1. 选 Auto,输入"格式化这段"(短) → 路由 FAST,顶栏显示 `Auto → fast-model`。
2. 选 Auto,prompt 提及"重构架构" → 路由 THINKING。
3. 打开 Max,任意 prompt → PREMIUM,thinking_mode=high。
4. 连发 5 条 → UsagePanel 中 byModel 累计正确,sparkline 出现今日点位。
5. 配额耗尽 → 顶栏红色警示,发送被阻断,提示文案明确。
