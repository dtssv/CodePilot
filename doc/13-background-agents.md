# 13 — Background Agents:并行任务、隔离 worktree(P3)

## 1. 目标

对齐 Cursor 的 Background Agents:

- 任务在**独立 git worktree** 中执行,**不阻塞**当前编辑会话。
- 多个任务并行,UI 有任务面板显示状态、日志、产出 PR。
- 任务完成后可"一键合并改动到主工作区"。

## 2. 现状

- 现有 `branches` 是**对话分支**,共享同一工作区文件。
- 没有 worktree 隔离、没有并发任务管理。

## 3. 概念

```
BackgroundTask
├── id
├── title / prompt
├── status: queued | running | needs_input | completed | failed | cancelled
├── worktreePath    (e.g. .codepilot/worktrees/<id>)
├── branchName      (Git 分支名,e.g. codepilot/task-<id>)
├── baseRef         (起点 commit)
├── sessionId       (内部独立会话)
├── createdAt / endedAt
└── outputs         { commits: [...], diffStat, prUrl? }
```

## 4. 后端

### 4.1 TaskManager

`plugin/src/main/kotlin/io/codepilot/plugin/background/BackgroundTaskManager.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class BackgroundTaskManager(private val project: Project) {
  data class Task(
    val id: String, val title: String, val prompt: String,
    var status: String, val worktreePath: String, val branchName: String,
    val baseRef: String, val sessionId: String,
    val createdAt: Long, var endedAt: Long? = null,
    var outputs: Outputs = Outputs(),
  )
  data class Outputs(
    val commits: MutableList<String> = mutableListOf(),
    var diffStat: String = "",
    var prUrl: String? = null,
  )

  private val tasks = ConcurrentHashMap<String, Task>()
  private val bus get() = project.getService(EventBus::class.java)
  private val semaphore = Semaphore(maxParallel())

  fun submit(title: String, prompt: String): Task {
    val id = "bg-${System.currentTimeMillis()}-${Random.nextInt(1000, 9999)}"
    val branch = "codepilot/task-$id"
    val wt = Path.of(project.basePath!!, ".codepilot", "worktrees", id).toString()
    val baseRef = git("rev-parse", "HEAD").trim()
    // 创建 worktree(若不在 git 库,先 init)
    git("worktree", "add", "-b", branch, wt, baseRef)
    val task = Task(id, title, prompt,
      status = "queued", worktreePath = wt, branchName = branch, baseRef = baseRef,
      sessionId = "bg-session-$id", createdAt = System.currentTimeMillis())
    tasks[id] = task
    emit()

    coroutineScope.launch {
      semaphore.withPermit { run(task) }
    }
    return task
  }

  private suspend fun run(task: Task) {
    task.status = "running"; emit()
    try {
      val client = ConversationClient.forWorkspace(task.worktreePath)
      client.userMessage(UserMessageRequest(
        sessionId = task.sessionId, text = task.prompt, mode = "agent",
        autoApply = true,
      )).collect { ev ->
        // 把 task 内的所有事件转发到主 bus,但 turnId 包前缀让 UI 能挂到任务卡
        bus.dispatchTaskScoped(task.id, ev)
      }
      // 收尾:commit + diff stat
      git("-C", task.worktreePath, "add", "-A")
      git("-C", task.worktreePath, "commit", "-m", "codepilot: ${task.title}").ifBlank { /* nothing to commit */ }
      task.outputs.diffStat = git("-C", task.worktreePath, "diff", "--stat", task.baseRef).trim()
      task.outputs.commits.addAll(
        git("-C", task.worktreePath, "log", "${task.baseRef}..HEAD", "--format=%H %s").lines().filter { it.isNotBlank() }
      )
      task.status = "completed"
    } catch (e: Throwable) {
      task.status = "failed"
      bus.emit("bg-${task.id}", "bg-error", "error",
        mapOf("code" to 5001, "message" to (e.message ?: "background task failed")))
    } finally {
      task.endedAt = System.currentTimeMillis()
      emit()
    }
  }

  fun cancel(id: String) {
    val t = tasks[id] ?: return
    if (t.status in setOf("queued", "running")) {
      ConversationClient.forSession(t.sessionId).stop()
      t.status = "cancelled"; t.endedAt = System.currentTimeMillis()
      emit()
    }
  }

  /** Merge task branch into current HEAD as a single squashed commit or N-way merge */
  fun mergeIntoMain(id: String, strategy: String = "squash"): Result<Unit> = runCatching {
    val t = tasks[id] ?: error("task not found")
    if (t.status != "completed") error("task not completed")
    when (strategy) {
      "squash" -> git("merge", "--squash", t.branchName).also { git("commit", "-m", "codepilot: ${t.title}") }
      "merge"  -> git("merge", "--no-ff", t.branchName, "-m", "Merge codepilot/${t.id}")
      else -> error("unknown strategy")
    }
  }

  fun openWorktree(id: String) {
    val t = tasks[id] ?: return
    // 用 IDEA 的 ProjectUtil.openProjectAsync 打开 worktree
    ProjectUtil.openOrImport(Path.of(t.worktreePath), null, true)
  }

  fun discard(id: String): Result<Unit> = runCatching {
    val t = tasks[id] ?: return@runCatching
    cancel(id)
    git("worktree", "remove", "--force", t.worktreePath)
    git("branch", "-D", t.branchName).also { /* ignore */ }
    tasks.remove(id)
    emit()
  }

  private fun maxParallel(): Int = Registry.intValue("codepilot.bg.max_parallel", 3)
  private fun emit() = bus.emit("system", "bg-tasks", "bg.tasks.update",
    mapOf("tasks" to tasks.values.map { it.toDto() }))

  private fun git(vararg args: String): String {
    val p = ProcessBuilder(listOf("git") + args).directory(java.io.File(project.basePath!!))
      .redirectErrorStream(true).start()
    val out = p.inputStream.bufferedReader().readText()
    if (p.waitFor() != 0) error("git ${args.joinToString(" ")} failed: $out")
    return out
  }
}
```

### 4.2 事件 scope

`EventBus` 增加 `dispatchTaskScoped`:把 envelope 的 type 前面追加 `bg.`,
turnId 加前缀 `bg-${taskId}-`,避免和主会话状态混淆。

```kotlin
fun dispatchTaskScoped(taskId: String, env: EventEnvelope) {
  val scoped = env.copy(
    turnId = "bg-${taskId}-${env.turnId}",
    type = "bg.${env.type}",            // 前端按 prefix 路由到任务面板
  )
  dispatch(scoped)
}
```

前端收到 `bg.*` 类型的事件,**不进入主 chat reducer**,而是路由到
`backgroundReducer`(独立 store)。

### 4.3 端点

```
bg.submit         { title, prompt }
bg.cancel         { id }
bg.discard        { id }
bg.merge          { id, strategy: 'squash'|'merge' }
bg.open_worktree  { id }
bg.list
bg.open_logs      { id }   → 返回 .codepilot/worktrees/<id>/.codepilot/session.log 路径
```

## 5. 前端

### 5.1 BackgroundTasksPanel

```tsx
export function BackgroundTasksPanel() {
  const tasks = useBgStore(s => s.tasks);
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="bg-panel">
      <div className="bg-header">
        <h3>Background Tasks</h3>
        <button onClick={() => setShowForm(true)}>新建任务</button>
      </div>
      <div className="bg-list">
        {tasks.map(t => <BgTaskCard key={t.id} task={t} />)}
      </div>
      {showForm && <NewTaskForm onClose={() => setShowForm(false)} />}
    </div>
  );
}

function BgTaskCard({ task }: { task: BgTask }) {
  const turns = useBgStore(s => s.turnsByTask[task.id] ?? []);
  const last = turns[turns.length - 1];
  return (
    <details className={`bg-task status-${task.status}`}>
      <summary>
        <span className={`bg-status-dot ${task.status}`} />
        <span className="bg-title">{task.title}</span>
        <span className="bg-branch">{task.branchName}</span>
        <span className="bg-time">{fmtRelative(task.createdAt)}</span>
        {task.status === 'running' && (
          <button onClick={(e) => { e.preventDefault(); sendToPlugin('bg.cancel', { id: task.id }); }}>取消</button>
        )}
      </summary>

      <div className="bg-prompt">{task.prompt}</div>

      {turns.length > 0 && (
        <details className="bg-log">
          <summary>实时日志({turns.length} turns)</summary>
          {turns.map(t => <pre key={t.turnId}>{t.userMessage}\n---\n{t.assistantText}</pre>)}
        </details>
      )}

      {task.status === 'completed' && (
        <div className="bg-outputs">
          <div><strong>{task.outputs.commits.length} commits</strong></div>
          <pre className="diff-stat">{task.outputs.diffStat}</pre>
          <div className="bg-actions">
            <button onClick={() => sendToPlugin('bg.open_worktree', { id: task.id })}>打开 worktree</button>
            <button onClick={() => sendToPlugin('bg.merge', { id: task.id, strategy: 'squash' })}>Squash 合并到主分支</button>
            <button onClick={() => sendToPlugin('bg.merge', { id: task.id, strategy: 'merge' })}>Merge commit</button>
            <button className="danger" onClick={() => confirm('丢弃任务?') && sendToPlugin('bg.discard', { id: task.id })}>丢弃</button>
          </div>
        </div>
      )}

      {task.status === 'failed' && (
        <div className="bg-error">
          <button onClick={() => sendToPlugin('bg.open_logs', { id: task.id })}>查看日志</button>
          <button onClick={() => sendToPlugin('bg.submit', { title: task.title, prompt: task.prompt })}>
            重试(新任务)
          </button>
        </div>
      )}
    </details>
  );
}
```

### 5.2 NewTaskForm

```tsx
function NewTaskForm({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  return (
    <div className="modal new-task-form">
      <h3>新建后台任务</h3>
      <input placeholder="任务标题" value={title} onChange={e => setTitle(e.target.value)} />
      <textarea rows={8} placeholder="详细指令(将在独立 worktree 中执行)"
        value={prompt} onChange={e => setPrompt(e.target.value)} />
      <div className="muted">
        将在 <code>.codepilot/worktrees/&lt;id&gt;</code> 创建独立工作区,
        基于当前 HEAD。完成后可一键合并或丢弃。
      </div>
      <div className="actions">
        <button onClick={onClose}>取消</button>
        <button disabled={!title || !prompt} onClick={() => {
          sendToPlugin('bg.submit', { title, prompt });
          onClose();
        }}>提交</button>
      </div>
    </div>
  );
}
```

### 5.3 入口

- 在 ChatView 的消息右下角加 "▶ 转为后台任务" 按钮,把当前 prompt + 上下文
  作为新 task 提交,主会话不阻塞。
- 顶栏添加角标 "BG (n running)"。

## 6. 并发与资源

- `BackgroundTaskManager` 用 `Semaphore` 限制并行度(默认 3,可配)。
- 每个 worktree 占用磁盘:任务结束 24h 后自动 `discard`(保留产出为 patch 文件
  存到 `.codepilot/archive/<id>.patch`)。
- 共享缓存:embedding 索引在主仓 + worktree 间复用(`AdaptiveDepthSearcher`
  支持 `--index-dir`)。

## 7. 冲突处理

merge 失败(冲突 / 工作区脏)→ task 状态 `merge_conflict`,前端给出三个选项:

1. 打开 worktree 手工 rebase
2. 让 LLM 解决冲突(submit 一个新 task `resolve conflicts for <id>`)
3. 放弃

## 8. 验收

1. 同时提交 3 个后台任务 → 全部并行执行,worktree 隔离,主会话可继续聊天。
2. 任务完成后点 "Squash 合并" → 主分支多出一个 commit;rollback 通过普通 git
   即可。
3. 任务失败 → 错误日志可查;点击"重试"创建新 task,id 不冲突。
4. 中途取消:进程被 kill,worktree 保留(便于排查),状态为 cancelled。
5. 关闭 IDE 再打开,正在 running 的任务被恢复为 `interrupted`(实际进程已死),
   提供"清理"按钮。
