# 08 — Shell 命令权限与流式输出(P1) ✅ Completed

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> 已实现: `shell/ShellPolicy.kt` 读取/写入 `.codepilot/shell-policy.json`,
> allow/deny/ask 三态与 workspace cwd 限制;`ShellExecutor` 集成 policy、确认弹窗、
> `beforeShellExecution` hook 和 stdout/stderr `shell.progress`/`tool.progress` 流式事件;
> WebUI `ShellPolicyPanel` 支持编辑规则。Prompt 核查: `shell.generate.txt` 已存在,
> `guard.system.txt` 已包含危险 shell 拒绝规则,无需后端改动。

## 1. 目标

- 模型调用 shell 工具前,按 **allowlist / denylist / ask** 三态决定是否运行,
  ask 时弹出确认对话(可"始终允许")。
- 命令执行 stdout/stderr **流式**实时回传 UI,而非结束才一次性下发。
- 长任务可在前端 **Stop**,后端 SIGINT/SIGTERM。

## 2. 现状

- `tools/ShellExecutor.kt` 已存在,但 result 是一次性返回。
- `tools/ReadOnlyShellGuard.kt` 有只读模式约束,但缺细粒度规则。
- 无前端确认对话。

## 3. 配置

`.codepilot/shell-policy.json`:

```json
{
  "defaultAction": "ask",
  "rules": [
    { "pattern": "^git (status|log|diff|show)( |$)", "action": "allow" },
    { "pattern": "^(ls|cat|head|tail|pwd|echo)( |$)", "action": "allow" },
    { "pattern": "^(npm|pnpm|yarn) (install|i|add|remove)( |$)", "action": "ask" },
    { "pattern": "^rm( |$)", "action": "deny" },
    { "pattern": "(>|>>|\\|)", "action": "ask" },
    { "pattern": "^curl ", "action": "ask" }
  ],
  "cwdWhitelist": ["${workspace}", "${workspace}/**"]
}
```

`defaultAction` ∈ `allow | deny | ask`。规则按顺序匹配,**首个命中**决定动作。

## 4. 后端

### 4.1 Policy 引擎

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/shell/ShellPolicy.kt
@Service(Service.Level.PROJECT)
class ShellPolicy(private val project: Project) {
  data class Rule(val pattern: Regex, val action: Action)
  enum class Action { ALLOW, DENY, ASK }
  data class Decision(val action: Action, val reason: String)

  @Volatile private var rules: List<Rule> = listOf()
  @Volatile private var defaultAction = Action.ASK
  private val sessionAllowed = ConcurrentHashMap.newKeySet<String>()  // "始终允许" 缓存

  fun reload() { /* 读 shell-policy.json */ }

  fun decide(command: String, cwd: String): Decision {
    if (sessionAllowed.contains(command)) return Decision(Action.ALLOW, "session-grant")
    if (!cwdAllowed(cwd)) return Decision(Action.DENY, "cwd outside whitelist: $cwd")
    val match = rules.firstOrNull { it.pattern.containsMatchIn(command) }
    return if (match != null) Decision(match.action, "rule: ${match.pattern}")
    else Decision(defaultAction, "default")
  }

  fun rememberAllow(command: String) { sessionAllowed.add(command) }
}
```

### 4.2 ShellExecutor 改造

```kotlin
@Service(Service.Level.PROJECT)
class ShellExecutor(private val project: Project) {
  private val bus get() = project.getService(EventBus::class.java)
  private val running = ConcurrentHashMap<String, Process>()

  /** 由 ToolDispatcher 调用;turnId/stepId 来自上层 */
  suspend fun execute(turnId: String, stepId: String, command: String, cwd: String): ToolResult.Shell {
    // 1) policy
    val policy = project.getService(ShellPolicy::class.java)
    val d = policy.decide(command, cwd)
    when (d.action) {
      ShellPolicy.Action.DENY -> return ToolResult.Shell(cwd, command, -1, "", "Denied: ${d.reason}", 0)
      ShellPolicy.Action.ASK -> {
        val grant = askUser(turnId, stepId, command, cwd, d.reason) ?: return ToolResult.Shell(
          cwd, command, -1, "", "User cancelled", 0)
        if (grant.remember) policy.rememberAllow(command)
        if (!grant.allow) return ToolResult.Shell(cwd, command, -1, "", "User denied", 0)
      }
      ShellPolicy.Action.ALLOW -> {}
    }
    // 2) hooks beforeShellExecution
    val hr = project.getService(HookEngine::class.java).run("beforeShellExecution",
      mapOf("command" to command, "cwd" to cwd))
    if (!hr.pass) return ToolResult.Shell(cwd, command, -1, "", "Blocked by hook: ${hr.reason}", 0)

    // 3) execute streamingly
    val t0 = System.currentTimeMillis()
    val pb = ProcessBuilder(parseCommand(command))
      .directory(java.io.File(cwd))
      .redirectErrorStream(false)
    val proc = pb.start()
    running[stepId] = proc

    val stdoutBuf = StringBuilder(); val stderrBuf = StringBuilder()
    coroutineScope {
      launch(Dispatchers.IO) {
        proc.inputStream.bufferedReader().forEachLine { line ->
          stdoutBuf.append(line).append('\n')
          bus.emit(turnId, stepId, "tool.progress",
            mapOf("stepId" to stepId, "partial" to mapOf("stream" to "stdout", "line" to line)))
        }
      }
      launch(Dispatchers.IO) {
        proc.errorStream.bufferedReader().forEachLine { line ->
          stderrBuf.append(line).append('\n')
          bus.emit(turnId, stepId, "tool.progress",
            mapOf("stepId" to stepId, "partial" to mapOf("stream" to "stderr", "line" to line)))
        }
      }
    }
    val exit = proc.waitFor()
    running.remove(stepId)
    return ToolResult.Shell(cwd, command, exit, stdoutBuf.toString(), stderrBuf.toString(),
      System.currentTimeMillis() - t0)
  }

  fun stop(stepId: String) {
    running[stepId]?.let {
      it.descendants().forEach { d -> d.destroy() }
      it.destroy()
    }
  }

  /** suspend until user responds via WebUI dialog */
  private suspend fun askUser(turnId: String, stepId: String, cmd: String, cwd: String,
                              reason: String): GrantDecision? {
    val token = "ask-${System.nanoTime()}"
    bus.emit(turnId, stepId, "shell.ask", mapOf(
      "token" to token, "command" to cmd, "cwd" to cwd, "reason" to reason))
    return GrantWaiter.await(token, 5 * 60_000)  // 5 min timeout
  }
}

data class GrantDecision(val allow: Boolean, val remember: Boolean)

object GrantWaiter {
  private val waiters = ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<GrantDecision>>()
  suspend fun await(token: String, timeoutMs: Long): GrantDecision? {
    val d = kotlinx.coroutines.CompletableDeferred<GrantDecision>()
    waiters[token] = d
    return withTimeoutOrNull(timeoutMs) { d.await() }.also { waiters.remove(token) }
  }
  fun complete(token: String, decision: GrantDecision) {
    waiters.remove(token)?.complete(decision)
  }
}
```

### 4.3 端点

```
shell.grant  { token, allow, remember }  → GrantWaiter.complete
shell.stop   { stepId }                   → ShellExecutor.stop
shell.policy.reload
shell.policy.set  { defaultAction, rules } (写回 shell-policy.json)
```

## 5. 前端

### 5.1 ShellConfirmDialog

监听 `shell.ask` envelope,弹出模态:

```tsx
// plugin/webui/src/components/shell/ShellConfirmDialog.tsx
export function ShellConfirmHost() {
  const [ask, setAsk] = useState<{ token: string; command: string; cwd: string; reason: string } | null>(null);

  useEffect(() => {
    return onEnvelope('shell.ask', (p) => setAsk(p));
  }, []);

  if (!ask) return null;
  const respond = (allow: boolean, remember: boolean) => {
    sendToPlugin('shell.grant', { token: ask.token, allow, remember });
    setAsk(null);
  };

  return (
    <div className="modal shell-confirm">
      <h3>是否允许运行命令?</h3>
      <div className="muted">原因:{ask.reason}</div>
      <pre className="cmd">$ {ask.command}</pre>
      <div className="muted">cwd: {ask.cwd}</div>
      <div className="actions">
        <button onClick={() => respond(false, false)}>拒绝</button>
        <button onClick={() => respond(true, false)}>本次允许</button>
        <button onClick={() => respond(true, true)}>本会话始终允许</button>
        <button onClick={() => { sendToPlugin('shell.policy.add_rule', {
          pattern: `^${ask.command.split(' ')[0]} `, action: 'allow',
        }); respond(true, false); }}>加入规则永久允许</button>
      </div>
    </div>
  );
}
```

`App.tsx` 顶层挂 `<ShellConfirmHost />`。

### 5.2 流式 Shell 输出

`ToolCallCard` 的 `ShellResult` 改为支持运行中 partial 模式;读取
`step.progressDetail.partial` 累积成 stdout/stderr:

```tsx
function ShellRunning({ step }: { step: StepNode }) {
  const partials = useShellPartials(step.stepId);  // 内部 hook 累积 progress
  return (
    <div className="shell-result running">
      <pre className="shell-stdout">{partials.stdout}</pre>
      {partials.stderr && <pre className="shell-stderr">{partials.stderr}</pre>}
      <button className="danger" onClick={() => sendToPlugin('shell.stop', { stepId: step.stepId })}>
        停止
      </button>
    </div>
  );
}
```

`useShellPartials` 实现:订阅 store 中 step 的 progressDetail,每次 partial
追加到对应 stream;step 结束时丢弃 partial,使用 final result。

```ts
function useShellPartials(stepId: string) {
  const step = useChatStore(s => s.steps[stepId]);
  const ref = useRef({ stdout: '', stderr: '' });
  useEffect(() => {
    const p = step?.progressDetail as { stream?: string; line?: string } | undefined;
    if (!p?.stream || !p.line) return;
    ref.current[p.stream as 'stdout' | 'stderr'] += p.line + '\n';
  }, [step?.progressDetail]);
  return ref.current;
}
```

### 5.3 Policy 编辑面板

```tsx
export function ShellPolicyPanel() {
  const policy = useChatStore(s => s.shellPolicy);
  return (
    <div className="shell-policy-panel">
      <h3>Shell 执行策略</h3>
      <label>
        默认动作:
        <select value={policy.defaultAction} onChange={e =>
          sendToPlugin('shell.policy.set', { ...policy, defaultAction: e.target.value })}>
          <option value="allow">总是允许</option>
          <option value="ask">每次询问</option>
          <option value="deny">总是拒绝</option>
        </select>
      </label>
      <table className="rules-table">
        <thead><tr><th>正则</th><th>动作</th><th></th></tr></thead>
        <tbody>
          {policy.rules.map((r, i) => (
            <tr key={i}>
              <td><code>{r.pattern}</code></td>
              <td>{r.action}</td>
              <td><button onClick={() => removeRule(i)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddRuleForm />
    </div>
  );
}
```

## 6. Edge cases

- **管道 / 重定向**:正则匹配 `(>|>>|\|)` 命中后强制 ASK,避免覆盖文件。
- **cwd 越界**:`cwdWhitelist` 不包含目标目录 → 立即 DENY,不进入 ASK。
- **shell 注入**:命令解析用 `parseCommand` 自前到后 tokenize,**不经过 sh -c**。
  确实需要 shell 特性的命令(如 `&&`)在 policy 里默认 ASK + reason="contains
  shell operator"。
- **长输出截断**:stdout/stderr 累积超过 100KB 时,后续按"每 5s 一个心跳行"
  显示,完整内容存盘 `.codepilot/shell-logs/{stepId}.log`,UI 提供"打开完整日志"。

## 7. 验收

1. `git status`:无确认直接执行,流式回显。
2. `rm -rf foo`:默认 deny,UI 显示拒绝并附 reason 与规则定位。
3. `npm install`:弹确认,选"本会话始终允许" → 同一命令二次调用无确认。
4. 长任务(如 `pnpm test`,运行 60s):UI 实时滚动输出;点 Stop → 后端
   SIGTERM,5s 未退出则 SIGKILL;tool.result 返回 exit code 143。
5. cwd 越界 → 立即拒绝,不弹确认。
