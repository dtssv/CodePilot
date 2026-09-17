# Telemetry / OpenTelemetry 追踪（OTLP 导出）

> 参考 claude-code 的 OpenTelemetry 机制：`@codepilot/core` 内置一套
> 轻量、零依赖的遥测实现（`packages/core/src/telemetry.ts`），通过
> 标准 OTEL 环境变量配置，以 OTLP/HTTP-JSON 协议把 trace 导出到任意
> 兼容的 collector（Jaeger、Grafana Tempo、Datadog Agent、
> OpenTelemetry Collector 等）。**默认完全关闭**，未配置 endpoint 时
> 所有遥测调用都是 no-op，零开销。

## 设计原则

- **隐私优先（Privacy-first）**：
  - **默认禁用** —— 不设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 就不会产生任何网络请求。
  - **不采集 PII** —— span 上只记录结构性元数据（session id、prompt 字符数、
    token 用量等），**绝不记录** prompt 内容、工具参数、文件内容或用户输入。
  - 可审计 —— 全部实现在一个不到 300 行的文件里，无第三方依赖，可直接通读。
- **零依赖**：不引入 `@opentelemetry/*`，手写 OTLP/HTTP-JSON 导出
  （基于 `node:http` / `node:https`），保持 core 包依赖为空。
- **永不破坏会话**：导出失败（collector 宕机、网络错误、非 2xx 响应）
  会被静默丢弃——遥测绝不能影响 agent 主流程。
- **标准兼容**：payload 严格遵循 OTLP/HTTP-JSON（`/v1/traces`），
  资源属性、span kind、exception event 语义都与 OpenTelemetry 规范对齐，
  任何兼容 collector 都能直接消费。

## 快速上手

```bash
# 1. 本地起一个 Jaeger（all-in-one，自带 OTLP HTTP 接收器）
docker run -d --name jaeger \
  -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:latest

# 2. 配置环境变量后正常跑 CodePilot
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=codepilot-dev
codepilot-tui

# 3. 打开 Jaeger UI 查看 trace
open http://localhost:16686   # Service 下拉选 codepilot-dev
```

## 配置（环境变量）

遥测只从环境变量读取配置（对齐 OpenTelemetry SDK 的惯例），
与 `config.json` 里的 `telemetry: { enabled: false }` 预留字段无关
（后者目前是 passthrough，见 CONFIG.md）。

| 变量 | 说明 | 默认值 |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector 的 base URL，例如 `http://localhost:4318`。trace 会被 POST 到 `<endpoint>/v1/traces`。**未设置 = 遥测整体禁用。** | （无） |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | traces 专用 endpoint，作为上一项的兜底（上一项优先）。 | （无） |
| `OTEL_TRACES_EXPORTER` | `otlp`（默认）启用导出；`none` 强制禁用（即使配了 endpoint）。 | `otlp` |
| `OTEL_SERVICE_NAME` | resource 上的 `service.name` 属性，在 Jaeger/Tempo 里作为服务名显示。 | `codepilot` |
| `OTEL_RESOURCE_ATTRIBUTES` | 逗号分隔的 `key=value` 列表，附加到 resource，例如 `env=prod,team=platform`。键值两侧空白会被裁剪；没有 `=` 的项被忽略。 | （空） |

判定逻辑（`loadTelemetryConfig`）：

```ts
const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
              ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const enabled  = Boolean(endpoint) && (env.OTEL_TRACES_EXPORTER ?? "otlp") !== "none";
```

示例：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com:4318
export OTEL_SERVICE_NAME=codepilot
export OTEL_RESOURCE_ATTRIBUTES="env=prod, region=us-east-1, version=1.2.3"
# 临时关掉导出但保留 endpoint 配置：
export OTEL_TRACES_EXPORTER=none
```

## Span 模型

一次 `session.prompt()` 会产生一棵 span 树：

```
codepilot.prompt            （根 span：一次用户 prompt 的完整生命周期）
├── codepilot.llm_call      （子 span：每次 LLM 流式请求，可多个——每个 agent 轮次一次）
│   └── codepilot.tool_call （子 span：每次工具执行，可多个）
└── codepilot.llm_call
    └── codepilot.tool_call
```

### `codepilot.prompt`（根 span，当前已接线）

由 `Session.prompt()` 创建，覆盖从收到用户输入到 agent 循环跑完
（含 compaction、checkpoint、Stop hooks）的整段时间。

| 属性 | 类型 | 说明 |
|---|---|---|
| `codepilot.session_id` | string | 会话 ID，可用于 `--resume` 关联。 |
| `codepilot.prompt_length` | number | prompt 的**字符数**（不记录内容本身）。 |

错误时：span status 置为 `error`，并附一条 `exception` event
（`exception.type` / `exception.message` / `exception.stacktrace`）。

### `codepilot.llm_call` / `codepilot.tool_call`（子 span）

Tracer 的 span 模型与属性通道已就绪（`kind`、父子 traceId 继承、
usage 属性、exception event——见 `telemetry.test.ts` 中的端到端用例）。
建议的接线点与属性约定（claude-code 对齐）：

| Span | 属性 | 说明 |
|---|---|---|
| `codepilot.llm_call` | `codepilot.provider`、`codepilot.model` | 本次请求的 provider 与模型。 |
| | `codepilot.usage.input` / `.output` / `.cache_read` / `.cache_write` | token 用量（number）。 |
| | `codepilot.cost_usd` | 估算成本（`estimateCostUSD`）。 |
| `codepilot.tool_call` | `codepilot.tool_name` | 工具名（如 `read_file`、`bash`）。 |
| | `codepilot.tool_success` | 工具是否成功（bool）。 |

> 注：子 span 的 traceId 继承通过 `parentSpanId` 在 Tracer 的缓冲列表里
> 解析——**父 span 必须先 `end()` 入队，子 span 才能拿到父 traceId**。
> 找不到父 span 时回退为新开一条 trace。

### 通用 span 字段

每个 span 都带标准 OTLP 字段：`traceId`（32 位 hex）、`spanId`（16 位 hex）、
`parentSpanId`、`name`、`kind`（默认 `1`=internal）、
`startTimeUnixNano` / `endTimeUnixNano`（纳秒字符串）、`attributes`、
`events`、`status`（`0`=unset / `1`=ok / `2`=error）。

Resource 上固定携带：

| 属性 | 来源 |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME`（默认 `codepilot`） |
| `host.name` | `os.hostname()` |
| 其余自定义键值 | `OTEL_RESOURCE_ATTRIBUTES` |

## OTLP 导出（HTTP-JSON）

- **协议**：OTLP/HTTP-JSON，`POST <endpoint>/v1/traces`，
  `content-type: application/json`。HTTP 与 HTTPS 均支持（按 URL scheme 自动选择）。
- **payload 结构**：`resourceSpans[0].resource.attributes` +
  `resourceSpans[0].scopeSpans[0].scope.name = "codepilot"` + spans 数组。
  属性按 OTLP 类型编码：string → `stringValue`、number → `doubleValue`、
  boolean → `boolValue`。
- **批处理**：span 先进入内存缓冲队列，触发以下任一条件即整批导出：
  - 缓冲数达到 **64**（`maxBatchSize`）→ 立即 flush；
  - 距首个入队 span 满 **5 秒**（`flushDelayMs`）→ 定时 flush；
  - 手动调用 `tracer.flush()`。
- **失败语义**：HTTP 状态码 ≥ 300 或网络错误时，该批 span 被**丢弃**
  （不重试、不堆积），异常被吞掉——telemetry must never break the session。
  flush 后缓冲清零，进程退出前未 flush 的尾部 span 可能丢失
  （嵌入方应在退出前调用一次 `await getTracer().flush()`）。

## 后端接入示例

### Jaeger（本地开发）

```bash
docker run -d --name jaeger -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:latest

export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Jaeger all-in-one 的 4318 端口原生接受 OTLP/HTTP，无需额外配置。
UI 在 <http://localhost:16686>，按 service name 筛选。

### Grafana Tempo

```yaml
# tempo.yaml（关键片段：开启 OTLP HTTP 接收器）
distributor:
  receivers:
    otlp:
      protocols:
        http:
```

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
```

然后在 Grafana 里配 Tempo datasource，按 `{ service.name = "codepilot" }` 查询。

### Datadog

通过 Datadog Agent 的 OTLP ingest：

```yaml
# datadog.yaml
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_RESOURCE_ATTRIBUTES="env=prod,team=platform"
```

### OpenTelemetry Collector（转发到任意后端）

```yaml
receivers:
  otlp:
    protocols:
      http:
exporters:
  otlphttp:
    endpoint: https://your-backend.example.com
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
```

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## 编程 API

全部从 `@codepilot/core` 导出（`index.ts`）：

```ts
import {
  Tracer,
  loadTelemetryConfig,
  getTracer,
  setTracer,
  type Span,
  type OtelTelemetryConfig,
} from "@codepilot/core";
```

### `loadTelemetryConfig(env?)`

从环境变量解析配置，返回 `TelemetryConfig`：

```ts
interface TelemetryConfig {
  endpoint?: string;                        // 未设置 = 禁用
  serviceName?: string;                     // 默认 "codepilot"
  resourceAttributes: Record<string, string>;
  enabled: boolean;                         // endpoint 存在且 exporter !== "none"
}
```

### `Tracer`

```ts
const tracer = new Tracer();                // 默认从 process.env 读取配置
// 或显式传入（测试常用）：
const tracer2 = new Tracer({
  endpoint: "http://localhost:4318",
  serviceName: "my-agent",
  resourceAttributes: { env: "test" },
  enabled: true,
});

tracer.enabled;                             // 当前是否启用
```

| 方法 | 说明 |
|---|---|
| `startSpan(name, opts?)` | 开启 span。`opts`：`parentSpanId?`（继承父 traceId）、`attributes?`（string/number/boolean 键值）、`kind?`（0=unspecified, 1=internal【默认】, 2=server, 3=client）。返回 `Span` 对象。 |
| `end(span)` | 结束 span（写 `endTimeUnixNano`）并入队等待导出。禁用时为 no-op（不写时间、不入队）。 |
| `recordError(span, err)` | 把 span status 置为 `error`（code 2 + message），并追加一条 `exception` event（含 `exception.type` / `exception.message` / `exception.stacktrace`）。 |
| `addEvent(span, name, attributes?)` | 给 span 追加结构化事件（带时间戳）。 |
| `flush()` | 立即把缓冲的所有 span 发到 endpoint。幂等；空缓冲或禁用时不发请求。导出失败静默丢弃。 |
| `bufferedCount()` | 返回当前未 flush 的 span 数（测试/调试用）。 |

典型用法：

```ts
const span = tracer.startSpan("codepilot.tool_call", {
  parentSpanId: parent.spanId,
  attributes: { "codepilot.tool_name": "bash" },
});
try {
  await doWork();
  tracer.addEvent(span, "tool_result", { ok: true });
} catch (err) {
  tracer.recordError(span, err as Error);
} finally {
  tracer.end(span);
}
```

### `getTracer()` / `setTracer(t | null)`

全局单例（惰性初始化，首次调用时从环境变量构建）：

```ts
const tracer = getTracer();        // 全局共享实例（Session.prompt 走的就是它）

// 测试里替换 / 重置：
setTracer(new Tracer({ enabled: false, resourceAttributes: {} }));
setTracer(null);                   // 下次 getTracer() 重新从 env 构建
```

## 性能

- **禁用时零开销**：没有 endpoint 时 `enabled = false`，`end()` 直接 return
  （不写时间、不入队），`flush()` 直接 return，`Session.prompt()` 连 span
  对象都不创建（`tracer.enabled ? startSpan(...) : undefined`）。
  不发起任何网络请求、不启动定时器。
- **启用时批量导出**：每批最多 64 个 span、单次 HTTP 请求；5 秒的
  flush 延迟把高频小 span（tool_call 风暴）合并成少量请求。
- **无第三方依赖**：导出只用 `node:http` / `node:https`，进程内存里
  只有一个 span 数组和一个定时器。
- **失败无重试风暴**：导出失败即丢弃该批，不排队重试，避免 collector
  宕机时拖垮宿主进程。

## 调试与验证

### 1. 确认配置是否生效

```bash
node -e "
const { loadTelemetryConfig } = require('@codepilot/core');
console.log(loadTelemetryConfig());
"
# 期望输出：{ endpoint: 'http://localhost:4318', serviceName: 'codepilot',
#            resourceAttributes: {...}, enabled: true }
```

### 2. 用本地 HTTP 服务器肉眼验证 payload

不装任何后端，直接看发出的 OTLP 请求：

```bash
node -e "
require('node:http').createServer((req, res) => {
  let d = ''; req.on('data', c => d += c);
  req.on('end', () => { console.log(JSON.stringify(JSON.parse(d), null, 2)); res.end('{}'); });
}).listen(4318, () => console.log('fake collector on :4318'));
" &
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
codepilot-tui -p --yolo "读取 package.json 并总结"
# 5 秒内应看到 resourceSpans payload 打到终端
```

### 3. 程序化检查

```ts
import { getTracer } from "@codepilot/core";

const tracer = getTracer();
console.log("enabled:", tracer.enabled);
console.log("buffered:", tracer.bufferedCount());
await tracer.flush();          // 进程退出前强制 flush
```

### 4. 跑遥测单测

```bash
pnpm vitest run packages/core/test/telemetry.test.ts
```

覆盖配置解析、span 结构、父子 traceId 继承、错误记录、批处理自动 flush、
导出失败兜底（500 / 连接拒绝）等 28 个用例。

### 常见问题

| 现象 | 排查 |
|---|---|
| Jaeger 里看不到 trace | 确认 `OTEL_EXPORTER_OTLP_ENDPOINT` 指向 **4318（HTTP）** 而不是 4317（gRPC）——本实现只发 OTLP/HTTP-JSON。 |
| 配了 endpoint 但没有请求 | 检查 `OTEL_TRACES_EXPORTER` 是否被设成了 `none`；用 `loadTelemetryConfig()` 打印 `enabled`。 |
| 进程退出丢尾部 span | 嵌入方（CLI/服务）退出前 `await getTracer().flush()`；定时 flush 有 5 秒窗口。 |
| collector 重启后旧 trace 消失 | 预期行为——导出失败即丢弃，不重试。 |
