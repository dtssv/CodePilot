# 06 — Rules + Memories(P1) ✅ Completed

> 已实现: `rules/RulesService.kt` 支持 `AGENTS.md`、`.codepilotrules`、
> `.codepilot/rules/*.mdc` 与用户级 rules;`memory/MemoryService.kt` 持久化
> `.codepilot/memories.json`;`CefChatPanel` 注入 active rules + approved memories 到
> `projectRules`;WebUI `RulesMemoryPanel` 支持 reload/create/approve/reject/delete。
> Prompt 核查: `rules.compile.txt` 和 `memory.distill.txt` 已补齐,后续可接服务端蒸馏。

## 1. 目标

替换/扩展现有 `NotepadsPanel`,对齐 Cursor:

- **Rules**:工作区 `.codepilot/rules/*.mdc`(frontmatter + markdown),按 glob
  自动激活,顶栏显示已激活 rule。
- **AGENTS.md**:工作区根目录约定文件,启动时自动注入。
- **Memories**:对话中自动沉淀的"用户偏好/项目知识",带审阅 UI(同意/驳回/
  编辑),全部存到 `.codepilot/memories.json`。

## 2. 现状

- `plugin/src/main/kotlin/io/codepilot/plugin/context/ProjectRulesLoader.kt`
  已经支持加载某种 rules,需要核对并扩展为 mdc 格式。
- `NotepadService.kt` 提供 notepads,但没有 frontmatter/glob 激活语义。
- 无 memories 功能。

## 3. Rule 文件格式

`.codepilot/rules/python-fastapi.mdc`:

```yaml
---
description: FastAPI 项目编码规范
globs:
  - "**/*.py"
alwaysApply: false        # true 则不依赖 glob,全局始终注入
priority: 10              # 数字越小优先级越高
---

# FastAPI Rules

- 路由文件统一放在 `app/api/`
- 所有 endpoint 必须用 `Annotated[..., Depends(...)]` 注入依赖
- 异常用 `app.errors.AppError` 派生,FastAPI 全局 handler 转 JSON
```

## 4. 后端

### 4.1 数据模型

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/rules/Rule.kt
data class Rule(
  val id: String,                      // 文件相对路径
  val description: String,
  val globs: List<String>,
  val alwaysApply: Boolean,
  val priority: Int,
  val body: String,
  val source: RuleSource,              // PROJECT | USER | AGENTS_MD
)
enum class RuleSource { PROJECT, USER, AGENTS_MD }
```

### 4.2 加载器(扩展 ProjectRulesLoader)

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/rules/RulesService.kt
@Service(Service.Level.PROJECT)
class RulesService(private val project: Project) {
  private val bus get() = project.getService(EventBus::class.java)
  @Volatile private var rules: List<Rule> = emptyList()

  fun reload() {
    val base = project.basePath ?: return
    val collected = mutableListOf<Rule>()

    // 1) AGENTS.md
    val agents = Path.of(base, "AGENTS.md")
    if (Files.exists(agents)) {
      collected.add(Rule(
        id = "AGENTS.md", description = "Workspace agent instructions",
        globs = emptyList(), alwaysApply = true, priority = 0,
        body = Files.readString(agents), source = RuleSource.AGENTS_MD,
      ))
    }

    // 2) project rules
    val dir = Path.of(base, ".codepilot", "rules")
    if (Files.isDirectory(dir)) {
      Files.walk(dir).filter { it.toString().endsWith(".mdc") }.forEach { p ->
        runCatching { collected.add(parseMdc(p, base, RuleSource.PROJECT)) }
      }
    }

    // 3) user rules(IDE 全局配置目录)
    val userDir = PathManager.getConfigPath() + "/codepilot/rules"
    Path.of(userDir).takeIf { Files.isDirectory(it) }?.let { d ->
      Files.walk(d).filter { it.toString().endsWith(".mdc") }.forEach { p ->
        runCatching { collected.add(parseMdc(p, userDir, RuleSource.USER)) }
      }
    }

    rules = collected.sortedBy { it.priority }
    bus.emit("system", "rules", "rules.loaded", mapOf("rules" to rules.map { it.toDto() }))
  }

  /** 由 ConversationClient 在每次 turn.start 前调用 */
  fun activeFor(workingFiles: List<String>): List<Rule> {
    return rules.filter { rule ->
      rule.alwaysApply || workingFiles.any { wf -> rule.globs.any { matchGlob(wf, it) } }
    }
  }

  fun renderForSystemPrompt(active: List<Rule>): String {
    if (active.isEmpty()) return ""
    return buildString {
      appendLine("## Workspace Rules (active)")
      active.forEach {
        appendLine("### ${it.id} — ${it.description}")
        appendLine(it.body)
        appendLine()
      }
    }
  }

  fun all() = rules
  fun save(rule: Rule) { /* 写回 .mdc + reload() */ }
  fun delete(id: String) { /* 删除文件 + reload() */ }
}

private fun parseMdc(p: Path, base: String, source: RuleSource): Rule {
  val text = Files.readString(p)
  val m = Regex("(?s)^---\\n(.*?)\\n---\\n(.*)\$").find(text)
    ?: return Rule(p.toString().removePrefix(base).trim('/'), "", emptyList(), false, 50, text, source)
  val fm = Yaml().load<Map<String, Any?>>(m.groupValues[1]) ?: emptyMap()
  return Rule(
    id = p.toString().removePrefix(base).trim('/'),
    description = fm["description"]?.toString() ?: "",
    globs = (fm["globs"] as? List<*>)?.map { it.toString() } ?: emptyList(),
    alwaysApply = fm["alwaysApply"] as? Boolean ?: false,
    priority = (fm["priority"] as? Int) ?: 50,
    body = m.groupValues[2],
    source = source,
  )
}
```

### 4.3 注入到 system prompt

`ConversationClient.userMessage` 在构建 prompt 时:

```kotlin
val working = req.contextRefs.mapNotNull { it.filePath }.distinct()
val active = rulesService.activeFor(working)
val prefix = rulesService.renderForSystemPrompt(active)
val finalSystem = "$basePrompt\n\n$prefix"
bus.emit(turnId, turnId, "rules.active",
  mapOf("rules" to active.map { mapOf("id" to it.id, "description" to it.description) }))
```

## 5. Memories

### 5.1 数据

`.codepilot/memories.json`:

```json
{
  "version": 1,
  "items": [
    {
      "id": "mem-2026-05-12-1",
      "content": "项目使用 pnpm 而非 npm",
      "scope": "project",
      "createdAt": 1715500000000,
      "source": "auto",
      "status": "accepted"
    }
  ]
}
```

### 5.2 自动提取

在 `turn.end` 时,调一次 fast 模型分析对话,生成候选 memory:

```kotlin
@Service(Service.Level.PROJECT)
class MemoryService(private val project: Project) {
  fun proposeFromTurn(turn: TurnSummary) {
    val candidates = ExtractMemoryModel.extract(turn.conversation)
    candidates.forEach { c ->
      addPending(c.copy(source = "auto", status = "pending"))
    }
    emit()
  }
  private fun emit() = bus.emit("system", "memories", "memories.update",
    mapOf("items" to load().items))
  fun accept(id: String) { setStatus(id, "accepted"); emit() }
  fun reject(id: String) { setStatus(id, "rejected"); emit() }
  fun edit(id: String, content: String) { ... emit() }
}
```

### 5.3 注入 system prompt

```kotlin
val mems = memoryService.accepted().joinToString("\n") { "- ${it.content}" }
val finalSystem = """
  $basePrompt
  ${if (mems.isNotEmpty()) "## Memories\n$mems\n" else ""}
  $rulesPrefix
""".trimIndent()
```

## 6. 前端

### 6.1 Rules 编辑面板

`plugin/webui/src/components/rules/RulesPanel.tsx`:

```tsx
export function RulesPanel() {
  const rules = useChatStore(s => s.rules);
  const [editing, setEditing] = useState<Rule | null>(null);
  return (
    <div className="rules-panel">
      <div className="rules-header">
        <h3>Rules</h3>
        <button onClick={() => setEditing(blankRule())}>新建 Rule</button>
      </div>
      <ul className="rules-list">
        {rules.map(r => (
          <li key={r.id} className={`rule-item source-${r.source}`}>
            <span className="rule-source">{r.source}</span>
            <span className="rule-id">{r.id}</span>
            <span className="rule-desc">{r.description}</span>
            <span className="rule-globs">{r.alwaysApply ? 'always' : r.globs.join(', ')}</span>
            <button onClick={() => setEditing(r)}>编辑</button>
            <button onClick={() => sendToPlugin('rules.delete', { id: r.id })}>删除</button>
          </li>
        ))}
      </ul>
      {editing && <RuleEditor rule={editing}
        onSave={r => { sendToPlugin('rules.save', r); setEditing(null); }}
        onClose={() => setEditing(null)} />}
    </div>
  );
}
```

`RuleEditor` 是一个 modal,字段:description / globs(多行)/ alwaysApply
checkbox / priority / body(textarea + 简易 markdown 预览)。

### 6.2 顶栏激活 Rule 指示

在 `App.tsx` top-bar 加:

```tsx
const activeRules = useChatStore(s => s.activeRules);
{activeRules.length > 0 && (
  <div className="active-rules-pill" title={activeRules.map(r => r.description).join('\n')}>
    📐 {activeRules.length} rules
  </div>
)}
```

### 6.3 Memories 审阅面板

```tsx
export function MemoriesPanel() {
  const items = useChatStore(s => s.memories);
  return (
    <div className="memories-panel">
      <h3>Memories</h3>
      <ul>
        {items.map(m => (
          <li key={m.id} className={`mem-${m.status}`}>
            <span className="mem-scope">{m.scope}</span>
            <span className="mem-content">{m.content}</span>
            {m.status === 'pending' && (
              <>
                <button onClick={() => sendToPlugin('memories.accept', { id: m.id })}>接受</button>
                <button onClick={() => sendToPlugin('memories.reject', { id: m.id })}>驳回</button>
                <button onClick={() => {
                  const v = prompt('编辑', m.content);
                  if (v) sendToPlugin('memories.edit', { id: m.id, content: v });
                }}>编辑</button>
              </>
            )}
            {m.status === 'accepted' && <button onClick={() => sendToPlugin('memories.reject', { id: m.id })}>移除</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## 7. NotepadsPanel 处理

Notepads 作为"非自动注入的草稿/片段",保留入口但**改名为 Snippets**;
旧的 notepad 数据迁移脚本:

```kotlin
// 启动一次性迁移
fun migrateNotepadsToRulesIfRequested() {
  val store = NotepadService.list()
  store.filter { it.tags.contains("rule") }.forEach { np ->
    RulesService.save(Rule(
      id = ".codepilot/rules/migrated-${np.id}.mdc",
      description = np.title, globs = listOf("**/*"),
      alwaysApply = true, priority = 50, body = np.content,
      source = RuleSource.PROJECT))
    NotepadService.delete(np.id)
  }
}
```

## 8. 验收

1. 在 `.codepilot/rules/foo.mdc` 写 `globs: ["**/*.py"]`,打开一个 `.py` 文件
   发起对话 → 顶栏出现 "1 rules"。
2. 修改 rule body 并保存 → 下一次 turn 即生效,无需重启。
3. 让模型完成一次"用户提醒用 pnpm"的对话 → MemoriesPanel 出现 pending 候选 →
   接受后,在新会话中模型自发使用 pnpm。
4. AGENTS.md 修改后,RulesPanel 自动刷新,标记 source=AGENTS_MD。
