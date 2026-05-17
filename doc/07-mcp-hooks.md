# 07 — MCP 管理 + Hooks(P1) ✅ Completed

> 已实现: `mcp/McpService.kt` 读取 `.codepilot/mcp.json`,封装
> `McpProcessManager` 的 list/start/stop/grant/editConfig;`hooks/HookEngine.kt`
> 读取 `.codepilot/hooks.json`,支持 `beforeSubmitPrompt` 与 `beforeShellExecution`;
> `CefChatPanel` 暴露 `mcp.*` / `hooks.*` bridge;WebUI `McpHooksPanel` 支持启停、
> 授权、hook 编辑。后端核查: MCP 主要在插件本地运行,无需新增服务器端点。

## 1. 目标

- MCP:将 `McpProcessManager` / `McpSseClient` 的能力暴露成可视面板:服务器列表
  / 启停 / 工具发现 / 权限授予。
- Hooks:新增"事件钩子"机制,允许用户在 `beforeSubmitPrompt` /
  `beforeShellExecution` / `afterFileEdit` 等节点跑脚本(本地命令)。

## 2. 现状

- 后端已有 `mcp/McpProcessManager.kt` / `mcp/McpSseClient.kt` /
  `mcp/McpSubscriptionManager.kt`,但 WebUI 没有面板。
- `MarketplacePanel.tsx` 占据一个 Tab 但定位不清。**计划替换为 MCP 面板**。
- 完全没有 hooks。

## 3. MCP

### 3.1 配置文件

`.codepilot/mcp.json`(沿用社区约定):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" }
    },
    "postgres": {
      "url": "http://localhost:3010/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

### 3.2 后端服务

`plugin/src/main/kotlin/io/codepilot/plugin/mcp/McpService.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class McpService(private val project: Project) {
  data class ServerStatus(
    val name: String,
    val state: String,                   // stopped | starting | running | error
    val transport: String,               // stdio | sse
    val tools: List<ToolSpec>,
    val resources: List<ResourceSpec>,
    val error: String? = null,
    val lastStartedAt: Long? = null,
  )
  data class ToolSpec(val name: String, val description: String, val schema: JsonElement,
                      val granted: Boolean)

  private val bus get() = project.getService(EventBus::class.java)
  private val statuses = ConcurrentHashMap<String, ServerStatus>()

  fun reloadConfig() {
    val cfg = readMcpJson() ?: return
    cfg.servers.forEach { (name, spec) ->
      statuses.putIfAbsent(name, ServerStatus(name, "stopped", spec.transport, emptyList(), emptyList()))
    }
    emit()
  }

  fun start(name: String) {
    val spec = readMcpJson()?.servers?.get(name) ?: return
    statuses[name] = statuses[name]!!.copy(state = "starting")
    emit()
    val client = when (spec.transport) {
      "stdio" -> McpProcessManager.start(spec.command!!, spec.args, spec.env) { onMessage(name, it) }
      "sse"   -> McpSseClient.connect(spec.url!!, spec.headers) { onMessage(name, it) }
      else -> error("unknown transport ${spec.transport}")
    }
    // discover tools
    client.listTools { tools ->
      statuses[name] = statuses[name]!!.copy(
        state = "running",
        tools = tools.map { ToolSpec(it.name, it.description, it.schema,
          granted = grantStore.isGranted(name, it.name)) },
        lastStartedAt = System.currentTimeMillis(),
      )
      emit()
    }
  }

  fun stop(name: String) { /* shutdown client; state=stopped */ emit() }
  fun setGranted(server: String, tool: String, granted: Boolean) {
    grantStore.set(server, tool, granted)
    statuses[server] = statuses[server]!!.copy(
      tools = statuses[server]!!.tools.map {
        if (it.name == tool) it.copy(granted = granted) else it
      })
    emit()
  }

  fun list(): List<ServerStatus> = statuses.values.toList()
  fun grantedTools(): List<Pair<String, ToolSpec>> =
    statuses.values.flatMap { s -> s.tools.filter { it.granted }.map { s.name to it } }

  private fun emit() = bus.emit("system", "mcp", "mcp.status", mapOf("servers" to list()))
}
```

### 3.3 工具桥接

LLM 看到的工具命名:`mcp.<server>.<tool>`。`ToolDispatcher` 收到后转发到对应
client,result payload 用 `kind: 'mcp'`:

```ts
| { kind: 'mcp'; server: string; tool: string; content: any; isError?: boolean }
```

### 3.4 端点

```
mcp.list_servers   → 返回 list()
mcp.start          { name }
mcp.stop           { name }
mcp.set_granted    { server, tool, granted }
mcp.reload         (重新读 mcp.json)
mcp.edit_config    { content }   (写回 .codepilot/mcp.json + reload)
```

### 3.5 前端

`plugin/webui/src/components/mcp/McpPanel.tsx`(替换原 `MarketplacePanel` Tab):

```tsx
export function McpPanel() {
  const servers = useChatStore(s => s.mcp);
  return (
    <div className="mcp-panel">
      <div className="mcp-header">
        <h3>MCP Servers</h3>
        <button onClick={() => sendToPlugin('mcp.reload', {})}>重载配置</button>
        <button onClick={openConfigEditor}>编辑 mcp.json</button>
      </div>
      {servers.map(s => (
        <details key={s.name} className={`mcp-server state-${s.state}`}>
          <summary>
            <span className={`state-dot state-${s.state}`} />
            <span className="server-name">{s.name}</span>
            <span className="server-transport">{s.transport}</span>
            {s.state === 'running'
              ? <button onClick={(e) => { e.preventDefault(); sendToPlugin('mcp.stop', { name: s.name }); }}>停止</button>
              : <button onClick={(e) => { e.preventDefault(); sendToPlugin('mcp.start', { name: s.name }); }}>启动</button>}
          </summary>
          {s.error && <div className="mcp-error">{s.error}</div>}
          <ul className="mcp-tools">
            {s.tools.map(t => (
              <li key={t.name}>
                <input type="checkbox" checked={t.granted}
                  onChange={e => sendToPlugin('mcp.set_granted', { server: s.name, tool: t.name, granted: e.target.checked })} />
                <span className="tool-name">{t.name}</span>
                <span className="tool-desc">{t.description}</span>
                <details><summary>schema</summary>
                  <pre>{JSON.stringify(t.schema, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
```

`App.tsx` 修改 tab-bar:`Marketplace` → `MCP`。原 marketplace 数据保留但移到
Settings 子页。

## 4. Hooks

### 4.1 Hook 配置

`.codepilot/hooks.json`:

```json
{
  "hooks": [
    {
      "event": "beforeSubmitPrompt",
      "command": "node",
      "args": ["scripts/redact-secrets.js"],
      "timeoutMs": 2000,
      "blocking": true
    },
    {
      "event": "beforeShellExecution",
      "command": "python",
      "args": ["scripts/cmd-policy.py"],
      "timeoutMs": 1000,
      "blocking": true
    },
    {
      "event": "afterFileEdit",
      "command": "pnpm",
      "args": ["lint:fix"],
      "blocking": false
    }
  ]
}
```

### 4.2 事件与契约

| 事件 | 输入(stdin JSON) | 输出 contract |
|---|---|---|
| `beforeSubmitPrompt` | `{ text, contextRefs, mode }` | `{ pass: bool, text?: string, reason?: string }` |
| `beforeShellExecution` | `{ command, cwd }` | `{ pass: bool, reason?: string }` |
| `beforeFileEdit` | `{ path, op, originalLen, proposedLen }` | `{ pass: bool, reason?: string }` |
| `afterFileEdit` | `{ path, op }` | 忽略 |
| `afterTurn` | `{ turnId, status }` | 忽略 |

`pass: false` 会**阻止**对应动作,并把 reason 显示给用户。`blocking: false` 则
异步执行,不影响主流程。

### 4.3 引擎

`plugin/src/main/kotlin/io/codepilot/plugin/hooks/HookEngine.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class HookEngine(private val project: Project) {
  data class HookSpec(val event: String, val command: String, val args: List<String>,
                      val cwd: String?, val timeoutMs: Long, val blocking: Boolean)
  data class HookResult(val pass: Boolean, val text: String? = null, val reason: String? = null)

  @Volatile private var hooks: List<HookSpec> = listOf()
  private val bus get() = project.getService(EventBus::class.java)

  fun reload() { hooks = readJson(); bus.emit("system", "hooks", "hooks.loaded", mapOf("hooks" to hooks)) }

  fun run(event: String, input: Any): HookResult {
    val matched = hooks.filter { it.event == event }
    if (matched.isEmpty()) return HookResult(pass = true)
    val inputJson = Gson().toJson(input)
    var current = inputJson
    for (h in matched) {
      val r = exec(h, current) ?: HookResult(pass = true)
      bus.emit("system", "hook-${System.nanoTime()}", "hook.run", mapOf(
        "event" to event, "command" to h.command, "pass" to r.pass, "reason" to r.reason,
      ))
      if (!r.pass) return r
      if (r.text != null && event == "beforeSubmitPrompt") {
        // 允许 hook 改写 prompt 文本
        current = Gson().toJson(mapOf("text" to r.text))
      }
    }
    return HookResult(pass = true, text = extractText(current))
  }

  private fun exec(h: HookSpec, stdinJson: String): HookResult? {
    val pb = ProcessBuilder(listOf(h.command) + h.args)
      .directory(java.io.File(h.cwd ?: project.basePath!!))
      .redirectErrorStream(false)
    val proc = pb.start()
    proc.outputStream.use { it.write(stdinJson.toByteArray()); it.flush() }
    val ok = proc.waitFor(h.timeoutMs, TimeUnit.MILLISECONDS)
    if (!ok) { proc.destroyForcibly(); return HookResult(false, reason = "hook timeout: ${h.command}") }
    val stdout = proc.inputStream.bufferedReader().readText()
    return runCatching { Gson().fromJson(stdout, HookResult::class.java) }.getOrNull()
      ?: HookResult(proc.exitValue() == 0, reason = if (proc.exitValue() != 0) "exit ${proc.exitValue()}" else null)
  }
}
```

### 4.4 接入点

- `ConversationClient.userMessage` 在发送给 SSE 前调:
  ```kotlin
  val hr = hookEngine.run("beforeSubmitPrompt", mapOf("text" to req.text, "contextRefs" to req.contextRefs, "mode" to req.mode))
  if (!hr.pass) { bus.emit(turnId, turnId, "error", mapOf("code" to 4001, "message" to "Blocked by hook: ${hr.reason}")); return }
  val realText = hr.text ?: req.text
  ```
- `ShellExecutor.execute` 在真正 spawn 前调:
  ```kotlin
  val hr = hookEngine.run("beforeShellExecution", mapOf("command" to cmd, "cwd" to cwd))
  if (!hr.pass) return ToolResult.Err("Blocked by hook: ${hr.reason}")
  ```
- `PatchStaging.apply` 在写盘前调 `beforeFileEdit`,落盘后调 `afterFileEdit`。
- `ConversationClient` 在 `turn.end` 后调 `afterTurn`。

### 4.5 前端 HooksPanel

```tsx
export function HooksPanel() {
  const hooks = useChatStore(s => s.hooks);
  return (
    <div className="hooks-panel">
      <h3>Hooks</h3>
      <div className="muted">.codepilot/hooks.json</div>
      <ul>
        {hooks.map((h, i) => (
          <li key={i}>
            <span className="hook-event">{h.event}</span>
            <code>{h.command} {h.args.join(' ')}</code>
            <span className={`hook-blocking ${h.blocking ? 'blocking' : 'async'}`}>
              {h.blocking ? '同步阻塞' : '异步'}
            </span>
            <span className="hook-timeout">{h.timeoutMs ?? 5000}ms</span>
          </li>
        ))}
      </ul>
      <button onClick={() => sendToPlugin('hooks.open_config', {})}>编辑 hooks.json</button>
      <button onClick={() => sendToPlugin('hooks.reload', {})}>重载</button>

      <h4>最近执行</h4>
      <ul className="hook-recent">
        {useChatStore(s => s.hookRunLog).slice(-20).map((r, i) => (
          <li key={i} className={r.pass ? 'ok' : 'blocked'}>
            <span>{new Date(r.ts).toLocaleTimeString()}</span>
            <span>{r.event}</span>
            <span>{r.command}</span>
            <span>{r.pass ? 'pass' : `blocked: ${r.reason}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## 5. 安全性

- Hook 命令默认仅运行在 `.codepilot/scripts/` 内的脚本(可通过 trust prompt 取消
  限制),首次出现新 hook 时弹"是否信任此 hook"对话框。
- MCP env 中的 `${env:XXX}` 替换在 Plugin 进程里完成,**不暴露给 LLM**。
- `mcp.set_granted` 的状态持久化到 `.codepilot/grants.json`,跨会话保留。

## 6. 验收

1. 在 `.codepilot/mcp.json` 配置 GitHub MCP server,启动后 McpPanel 显示工具
   列表;勾选 `search_issues` → 在聊天中模型可调用,result kind=mcp。
2. 配置 `beforeSubmitPrompt` hook,脚本 stdout 输出 `{"pass": false, "reason":
   "包含敏感词"}` → 发送被阻断,聊天区显示阻断原因。
3. 配置 `beforeShellExecution` hook 拒绝 `rm -rf` → LLM 试图执行时被拦截,
   tool.result 显示拒绝原因。
4. Hook 超时 → 1 秒内主流程继续(blocking=true 时返回 reason=timeout,pass=false)。
