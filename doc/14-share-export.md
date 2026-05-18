# 14 — 会话分享与导出(P3)

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> ✅ Completed(2026-05-17):已新增 `ExportService`、Export WebUI 面板和
> `export.preview/export.save_file/share.create` bridge。支持 Markdown、PR
> Description、JSON 预览/保存/复制;`share.create` 采用 offline-first 本地
> `.codepilot/share/*.md` 文件 URL,可后续替换为云端 share-service。

## 1. 目标

- **导出**:把当前会话(或选定的 turn 范围)导出为 Markdown / JSON / PR
  description 模板。
- **分享**:生成可分享 URL(可选,需要后端服务支持);**离线模式**走本地
  Markdown 文件 + 复制按钮。

## 2. 现状

无任何导出/分享入口。

## 3. 导出格式

### 3.1 Markdown

```markdown
# CodePilot 会话:<title>

> Session: <sessionId> · 2026-05-17 19:42 · Model: gpt-5
> Workspace: ~/proj/foo · Cost: $0.42 · Turns: 12

## Turn 1 · 用户

请重构 X 模块为 async/await。

**Context**: `src/x.ts` (file), grep "callback" (codebase)

## Turn 1 · 助手

我先读取 src/x.ts ...

### Tool: fs.read
```
{ "path": "src/x.ts", "range": [1, 200] }
```

### Tool: fs.write
```diff
--- a/src/x.ts
+++ b/src/x.ts
@@ -10,7 +10,7 @@
-function foo(cb) {
+async function foo() {
```

(已 Accept)
```

### 3.2 PR Description 模板

```markdown
## Summary
- 重构 X 模块为 async/await(2 个文件)
- 修复 Y 边界条件

## Changes
- `src/x.ts`: function foo() 改 async,3 处 callback → await
- `src/y.ts`: race 条件修复

## Test Plan
- [x] 单元测试:`pnpm test src/x.test.ts`
- [ ] 手工:验证 UI 中按钮回调仍正常

---
由 CodePilot 协助生成 · session bg-2026-05-17-abc
```

### 3.3 JSON(完整可重放)

包含全部 envelope 序列,可在 dev 模式下重放,亦可作 bug 报告附件。

## 4. 后端

`plugin/src/main/kotlin/io/codepilot/plugin/export/ExportService.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class ExportService(private val project: Project) {
  enum class Format { MARKDOWN, PR_DESCRIPTION, JSON }

  fun export(sessionId: String, format: Format,
             range: IntRange? = null, includeTools: Boolean = true): String {
    val session = SessionStore.getInstance(project).load(sessionId)
    val turns = session.turns.let { if (range != null) it.slice(range) else it }
    return when (format) {
      Format.MARKDOWN       -> renderMarkdown(session, turns, includeTools)
      Format.PR_DESCRIPTION -> renderPr(session, turns)
      Format.JSON           -> Gson().toJson(mapOf("session" to session, "turns" to turns))
    }
  }

  fun saveToFile(sessionId: String, format: Format, target: Path) {
    Files.writeString(target, export(sessionId, format), StandardOpenOption.CREATE)
  }

  private fun renderMarkdown(s: Session, turns: List<Turn>, includeTools: Boolean): String = buildString {
    appendLine("# CodePilot 会话:${s.title}")
    appendLine()
    appendLine("> Session: `${s.id}` · ${fmtTs(s.createdAt)} · Model: ${s.primaryModel}")
    appendLine("> Workspace: `${s.workspacePath}` · Cost: \$${"%.4f".format(s.totalCost)} · Turns: ${turns.size}")
    appendLine()
    turns.forEachIndexed { i, t ->
      appendLine("## Turn ${i + 1} · 用户")
      appendLine()
      appendLine(t.userMessage)
      if (t.contextRefs.isNotEmpty()) {
        appendLine()
        appendLine("**Context**: " + t.contextRefs.joinToString { "`${it.display}` (${it.type ?: "?"})" })
      }
      appendLine()
      appendLine("## Turn ${i + 1} · 助手")
      appendLine()
      appendLine(t.assistantText)
      if (includeTools) {
        t.toolCalls.forEach { tc ->
          appendLine()
          appendLine("### Tool: `${tc.tool}` (${if (tc.ok) "✓" else "✗"})")
          appendLine("```json")
          appendLine(Gson().toJson(tc.args))
          appendLine("```")
          renderToolResultBlock(tc)?.let { appendLine(it) }
        }
      }
      appendLine()
    }
  }

  private fun renderPr(s: Session, turns: List<Turn>): String = buildString {
    // 用 fast 模型让 LLM 生成 PR 描述
    val raw = renderMarkdown(s, turns, false)
    val pr = SummarizerModel.makePrDescription(raw,
      filesChanged = collectFiles(turns), diffStat = collectDiffStat(turns))
    appendLine(pr)
    appendLine()
    appendLine("---")
    appendLine("由 CodePilot 协助生成 · session `${s.id}`")
  }

  private fun renderToolResultBlock(tc: ToolCallRecord): String? {
    val r = tc.result ?: return null
    return when (r["kind"]) {
      "fs.write" -> {
        val diff = r["diff"] as Map<*, *>
        "```diff\n" + (diff["hunks"] as List<*>).joinToString("\n") + "\n```"
      }
      "grep" -> "命中 ${r["total"]} 行,前 5 条:\n" +
        (r["matches"] as List<Map<String, *>>).take(5).joinToString("\n") { "- ${it["path"]}:${it["line"]} ${it["preview"]}" }
      "shell" -> "```\n$ ${r["command"]}\nexit ${r["exitCode"]} · ${r["durationMs"]}ms\n${r["stdout"]}\n```"
      else -> null
    }
  }
}
```

### 4.1 端点

```
export.preview   { sessionId, format, range?, includeTools? }   → export.preview.result
export.save_file { sessionId, format, path }                    → 写文件 + 返回 ok
export.copy      { sessionId, format, range? }                  → 内容由前端复制到剪贴板
share.create     { sessionId, expireDays }                      → 上传到 share-service,返回 URL
share.list       (列出当前账号已分享链接)
share.revoke     { shareId }
```

## 5. 前端

### 5.1 ExportDialog

```tsx
export function ExportDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [format, setFormat] = useState<'markdown'|'pr_description'|'json'>('markdown');
  const [includeTools, setIncludeTools] = useState(true);
  const [includeRange, setIncludeRange] = useState<'all'|'recent5'|'custom'>('all');
  const [from, setFrom] = useState(1); const [to, setTo] = useState(99);
  const [preview, setPreview] = useState('');

  const refresh = async () => {
    const range = includeRange === 'all' ? null
      : includeRange === 'recent5' ? { from: -5, to: -1 }
      : { from: from - 1, to: to - 1 };
    const r = await sendToPlugin('export.preview', { sessionId, format, range, includeTools });
    setPreview(JSON.parse(r).content);
  };
  useEffect(() => { refresh(); }, [format, includeTools, includeRange, from, to]);

  return (
    <div className="modal export-dialog">
      <h3>导出会话</h3>
      <div className="row">
        <label>格式:
          <select value={format} onChange={e => setFormat(e.target.value as any)}>
            <option value="markdown">Markdown</option>
            <option value="pr_description">PR 描述</option>
            <option value="json">JSON(完整 envelope)</option>
          </select>
        </label>
        <label><input type="checkbox" checked={includeTools}
          onChange={e => setIncludeTools(e.target.checked)} /> 包含工具调用</label>
      </div>
      <div className="row">
        <label>范围:
          <select value={includeRange} onChange={e => setIncludeRange(e.target.value as any)}>
            <option value="all">全部</option>
            <option value="recent5">最近 5 轮</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {includeRange === 'custom' && (
          <>
            <input type="number" min={1} value={from} onChange={e => setFrom(+e.target.value)} /> ~
            <input type="number" min={from} value={to} onChange={e => setTo(+e.target.value)} />
          </>
        )}
      </div>

      <pre className="export-preview">{preview}</pre>

      <div className="actions">
        <button onClick={() => navigator.clipboard.writeText(preview)}>复制到剪贴板</button>
        <button onClick={async () => {
          const path = prompt('保存到', `${sessionId}.md`);
          if (path) await sendToPlugin('export.save_file', { sessionId, format, path });
        }}>保存为文件</button>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
```

### 5.2 入口

- ChatView 头部右上角加 "导出" / "分享" 两个图标。
- 顶栏 `History popup` 每个 session 卡片右键菜单 → 导出。

## 6. Share(可选,需后端 share-service)

如果项目侧已有 share-service:

```kotlin
fun createShare(sessionId: String, expireDays: Int): String {
  val payload = mapOf(
    "session" to SessionStore.load(sessionId),
    "expireAt" to (System.currentTimeMillis() + expireDays * 86400_000L),
  )
  val resp = httpClient.post("$shareBase/api/shares")
    .header("Authorization", "Bearer ${auth.token}")
    .body(Gson().toJson(payload)).send()
  val shareId = resp.json["id"].asString
  return "$shareBase/s/$shareId"
}
```

无 share-service 时:`share.create` 端点不可用,前端按钮 disabled +
tooltip "未配置 share-service,改用导出/复制"。

## 7. 隐私扫描

导出前自动扫描:

- 文件路径中的用户名(`/Users/<x>/`、`C:\Users\<x>\`)→ 替换为 `~`
- 常见 secret 模式(`api_key=...`、`token=...`、AWS_KEY)→ 标红 + 询问是否
  替换为 `***REDACTED***`

实现位于 `ExportService.scrubPii(text: String)`,默认开启,UI 可关闭。

## 8. 验收

1. 选 Markdown + 全部 → 预览区出现,工具调用可显示 diff 块。
2. PR 描述模式 → 自动包含 "## Summary / ## Test Plan",可贴到 GitHub PR。
3. 含路径 `/Users/wz/secret.env` 的会话 → 导出后路径被脱敏。
4. 保存到 `~/Desktop/x.md` → 实际文件存在且内容与预览一致。
5. 若 share-service 已配:`share.create expireDays=7` → URL 可在浏览器打开。
