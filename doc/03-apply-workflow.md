# 03 — Hunk 级 Apply 工作流 + Undo all AI changes(P0) ✅ Completed

> 已实现:`apply/DiffUtil.kt` 纯 Kotlin LCS 行级 diff;`apply/PatchStaging.kt` 项目级
> 服务承载暂存/接受/驳回/提交/撤销;`ToolDispatcher.tryStage` 在
> `stageBeforeApply` 开启时拦截 `fs.write/create/replace/delete`;`CefChatPanel`
> 暴露 `apply.list / apply.hunk_status / apply.apply_file / apply.apply_all /
> apply.reject_file / apply.reapply / apply.undo_turn`;`EventTypes.PENDING_UPDATE`
> 通过 EventBus 广播。前端:`state/pending.ts` 订阅 envelope + list_response,
> `components/apply/{ChangePanel,FileChangeCard,HunkView}.tsx` 提供 UI;
> 测试 `DiffUtilTest.kt` + `pending.test.ts`。


## 1. 目标

Cursor 的差异化能力之一:对 LLM 生成的修改**逐文件、逐 hunk** Accept/Reject,
失败可智能 re-apply,整轮可一键回滚。当前 `App.tsx:768-791` 只有"全部应用 /
清除列表"。

## 2. 概念模型

```
Turn
└── PendingChangeSet (turnId 范围内所有写盘动作的暂存)
    ├── PendingFile #1
    │   ├── Hunk #1   (accepted | rejected | pending)
    │   ├── Hunk #2
    │   └── ...
    ├── PendingFile #2
    └── ...
```

**关键约束**:LLM 工具调用 `fs.write` / `fs.applyPatch` 时,**不直接落盘**,
而是写入 `PatchStaging`,返回 `pendingId`。前端基于 `pendingId` 进行交互。

## 3. 后端

### 3.1 PatchStaging 服务

`plugin/src/main/kotlin/io/codepilot/plugin/apply/PatchStaging.kt`:

```kotlin
package io.codepilot.plugin.apply

import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import io.codepilot.plugin.protocol.EventBus
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class Hunk(
  val id: String,
  val oldStart: Int, val oldLines: Int,
  val newStart: Int, val newLines: Int,
  val lines: List<String>,             // 标准 unified diff 行(含前缀 ' ' '+' '-')
  var status: HunkStatus = HunkStatus.PENDING,
)

enum class HunkStatus { PENDING, ACCEPTED, REJECTED, APPLIED }

data class PendingFile(
  val pendingId: String,
  val turnId: String,
  val path: String,                    // workspace 相对路径
  val op: String,                      // create | replace | delete
  val originalContent: String?,        // 用于回滚
  val proposedContent: String,         // 全量目标内容
  val hunks: MutableList<Hunk>,
  var applied: Boolean = false,
)

@Service(Service.Level.PROJECT)
class PatchStaging(private val project: Project) {
  private val bus get() = project.getService(EventBus::class.java)
  private val files = ConcurrentHashMap<String, PendingFile>()
  private val byTurn = ConcurrentHashMap<String, MutableList<String>>()

  /** 由 fs.write/applyPatch 工具调用 */
  fun stage(turnId: String, path: String, op: String,
            originalContent: String?, proposedContent: String): PendingFile {
    val hunks = DiffUtil.unifiedHunks(originalContent ?: "", proposedContent)
      .mapIndexed { i, h -> h.copy(id = "h$i") }
      .toMutableList()
    val pf = PendingFile(
      pendingId = "pf-${UUID.randomUUID()}",
      turnId = turnId, path = path, op = op,
      originalContent = originalContent, proposedContent = proposedContent,
      hunks = hunks,
    )
    files[pf.pendingId] = pf
    byTurn.computeIfAbsent(turnId) { mutableListOf() }.add(pf.pendingId)
    emitPending()
    return pf
  }

  fun setHunkStatus(pendingId: String, hunkId: String, status: HunkStatus) {
    val pf = files[pendingId] ?: return
    pf.hunks.firstOrNull { it.id == hunkId }?.status = status
    emitPending()
  }

  /** 应用单个 pending file:按 ACCEPTED hunks 重建目标内容 */
  fun apply(pendingId: String): Result<Unit> = runCatching {
    val pf = files[pendingId] ?: error("pending not found")
    if (pf.applied) return@runCatching
    val target = rebuildFromAcceptedHunks(pf)
    writeFile(pf.path, target, pf.op == "delete")
    pf.applied = true
    pf.hunks.forEach { if (it.status == HunkStatus.ACCEPTED) it.status = HunkStatus.APPLIED }
    emitPending()
  }

  fun applyAll(turnId: String) {
    byTurn[turnId]?.forEach { apply(it) }
  }

  /** Undo all AI changes for a turn:逆序还原 originalContent */
  fun undoTurn(turnId: String) {
    val ids = byTurn[turnId] ?: return
    ids.reversed().forEach { id ->
      val pf = files[id] ?: return@forEach
      if (pf.applied) {
        if (pf.op == "create") {
          // 创建文件 → 删除
          deleteFile(pf.path)
        } else {
          writeFile(pf.path, pf.originalContent ?: "", false)
        }
        pf.applied = false
        pf.hunks.forEach { it.status = HunkStatus.PENDING }
      }
    }
    emitPending()
  }

  fun list(turnId: String? = null): List<PendingFile> =
    if (turnId != null) byTurn[turnId].orEmpty().mapNotNull { files[it] }
    else files.values.toList()

  fun reapply(pendingId: String): Result<Unit> = runCatching {
    val pf = files[pendingId] ?: error("pending not found")
    // 重新计算 diff(目标内容可能已被外部修改)
    val currentDisk = readCurrentDisk(pf.path)
    val newHunks = DiffUtil.unifiedHunks(currentDisk, pf.proposedContent)
      .mapIndexed { i, h -> h.copy(id = "h$i") }
    pf.hunks.clear(); pf.hunks.addAll(newHunks)
    pf.applied = false
    emitPending()
  }

  // ---- helpers ----
  private fun rebuildFromAcceptedHunks(pf: PendingFile): String {
    val accepted = pf.hunks.filter { it.status == HunkStatus.ACCEPTED || it.status == HunkStatus.APPLIED }
    return DiffUtil.applyHunks(pf.originalContent ?: "", accepted)
  }

  private fun writeFile(rel: String, content: String, delete: Boolean) {
    val base = project.basePath ?: error("no basePath")
    val p = Path.of(base, rel)
    WriteAction.runAndWait<RuntimeException> {
      if (delete) {
        Files.deleteIfExists(p)
      } else {
        Files.createDirectories(p.parent)
        Files.writeString(p, content)
      }
      VfsUtil.findFile(p, true)?.refresh(false, false)
      LocalFileSystem.getInstance().refreshAndFindFileByNioFile(p)
    }
  }

  private fun deleteFile(rel: String) = writeFile(rel, "", delete = true)

  private fun readCurrentDisk(rel: String): String {
    val base = project.basePath ?: return ""
    val p = Path.of(base, rel)
    return if (Files.exists(p)) Files.readString(p) else ""
  }

  private fun emitPending() {
    // 广播一份给 WebUI
    val turnId = files.values.firstOrNull()?.turnId ?: return
    bus.emit(turnId, "pending-${System.nanoTime()}", "pending.update",
      mapOf("files" to files.values.map { it.toDto() }))
  }
}

private fun PendingFile.toDto() = mapOf(
  "pendingId" to pendingId, "turnId" to turnId, "path" to path, "op" to op,
  "applied" to applied,
  "hunks" to hunks.map { mapOf(
    "id" to it.id,
    "oldStart" to it.oldStart, "oldLines" to it.oldLines,
    "newStart" to it.newStart, "newLines" to it.newLines,
    "lines" to it.lines, "status" to it.status.name,
  ) },
)
```

### 3.2 DiffUtil(基于 IntelliJ 自带 diff)

`plugin/src/main/kotlin/io/codepilot/plugin/apply/DiffUtil.kt`:

```kotlin
package io.codepilot.plugin.apply

import com.intellij.diff.comparison.ComparisonManager
import com.intellij.diff.comparison.ComparisonPolicy
import com.intellij.openapi.progress.EmptyProgressIndicator

object DiffUtil {
  fun unifiedHunks(oldText: String, newText: String): List<Hunk> {
    val frags = ComparisonManager.getInstance()
      .compareLines(oldText, newText, ComparisonPolicy.DEFAULT, EmptyProgressIndicator())
    val oldLines = oldText.split("\n")
    val newLines = newText.split("\n")
    return frags.map { f ->
      val ctxLines = mutableListOf<String>()
      // 上文 3 行
      val ctxStart = maxOf(0, f.startLine1 - 3)
      for (i in ctxStart until f.startLine1) ctxLines.add(" ${oldLines[i]}")
      for (i in f.startLine1 until f.endLine1) ctxLines.add("-${oldLines[i]}")
      for (i in f.startLine2 until f.endLine2) ctxLines.add("+${newLines[i]}")
      val ctxEnd = minOf(oldLines.size, f.endLine1 + 3)
      for (i in f.endLine1 until ctxEnd) ctxLines.add(" ${oldLines[i]}")
      Hunk(
        id = "",
        oldStart = ctxStart + 1, oldLines = ctxEnd - ctxStart,
        newStart = ctxStart + 1, newLines = (ctxEnd - ctxStart) + (f.endLine2 - f.startLine2) - (f.endLine1 - f.startLine1),
        lines = ctxLines,
      )
    }
  }

  /** 仅应用 accepted hunks 到 oldText,产出新文本 */
  fun applyHunks(oldText: String, accepted: List<Hunk>): String {
    if (accepted.isEmpty()) return oldText
    val src = oldText.split("\n").toMutableList()
    // 从后往前应用,避免行号偏移
    accepted.sortedByDescending { it.oldStart }.forEach { h ->
      val removed = h.lines.count { it.startsWith("-") }
      val added = h.lines.filter { it.startsWith("+") }.map { it.substring(1) }
      val removeStart = h.oldStart - 1 + h.lines.takeWhile { it.startsWith(" ") }.size
      repeat(removed) { if (removeStart < src.size) src.removeAt(removeStart) }
      src.addAll(removeStart, added)
    }
    return src.joinToString("\n")
  }
}
```

### 3.3 工具集成

`fs.write` / `fs.applyPatch` 工具的实现改为:

```kotlin
class FsWriteTool(private val project: Project) {
  fun execute(turnId: String, args: FsWriteArgs): ToolResult {
    val original = if (args.op == "create") null else readWorkspaceFile(args.path)
    val pf = project.getService(PatchStaging::class.java)
      .stage(turnId, args.path, args.op, original, args.content)
    return ToolResult.FsWrite(
      path = args.path,
      op = args.op,
      diff = pf.toUnifiedDiff(),
      pendingId = pf.pendingId,
    )
  }
}
```

### 3.4 CefBridge 端点

```kotlin
"apply.hunk_status" -> staging.setHunkStatus(p["pendingId"], p["hunkId"], HunkStatus.valueOf(p["status"]))
"apply.apply_file" -> staging.apply(p["pendingId"])
"apply.apply_all"  -> staging.applyAll(SessionState.activeTurnId()!!)
"apply.reject_file"-> { staging.list().firstOrNull { it.pendingId == p["pendingId"] }
                          ?.hunks?.forEach { it.status = HunkStatus.REJECTED }; staging.emitPending() }
"apply.undo_turn"  -> staging.undoTurn(p["turnId"])
"apply.reapply"    -> staging.reapply(p["pendingId"])
```

### 3.5 自动应用(auto-apply)

保留 `App.tsx` 的 `autoApply` 开关,但语义改为:**当 turn 内所有 pending file
都通过 `risk_notice` 评估为低风险时,自动调用 `apply.apply_all`**。
评估逻辑在 `PathGuard.kt` 里加 `riskOf(path)` 方法,返回 LOW/MEDIUM/HIGH。

## 4. 前端

### 4.1 状态

`pendingChanges` 由 `pending.update` envelope 维护,挂到 `useChatStore`:

```ts
// state/events.ts
export interface PendingHunk {
  id: string; oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: string[]; status: 'PENDING'|'ACCEPTED'|'REJECTED'|'APPLIED';
}
export interface PendingFile {
  pendingId: string; turnId: string; path: string; op: 'create'|'replace'|'delete';
  applied: boolean; hunks: PendingHunk[];
}

// 在 reducer 中处理:
case 'pending.update': {
  const p = ev.payload as { files: PendingFile[] };
  return { ...next, pendingFiles: p.files };
}
```

### 4.2 ChangePanel

`plugin/webui/src/components/apply/ChangePanel.tsx`:

```tsx
import { useChatStore } from '../../state/sessionStore';
import { sendToPlugin } from '../../bridge';
import { HunkView } from './HunkView';

export function ChangePanel({ turnId }: { turnId: string }) {
  const files = useChatStore(s => s.pendingFiles?.filter(f => f.turnId === turnId) ?? []);
  if (files.length === 0) return null;
  const anyApplied = files.some(f => f.applied);

  return (
    <div className="change-panel">
      <div className="change-panel-header">
        <span>待变更 {files.length} 个文件</span>
        <div className="change-panel-actions">
          <button onClick={() => sendToPlugin('apply.apply_all', { turnId })}>全部应用</button>
          {anyApplied && (
            <button className="danger" onClick={() => sendToPlugin('apply.undo_turn', { turnId })}>
              撤销本轮所有 AI 改动
            </button>
          )}
        </div>
      </div>
      {files.map(f => <FileChangeCard key={f.pendingId} file={f} />)}
    </div>
  );
}

function FileChangeCard({ file }: { file: PendingFile }) {
  const accept = (hunkId: string) =>
    sendToPlugin('apply.hunk_status', { pendingId: file.pendingId, hunkId, status: 'ACCEPTED' });
  const reject = (hunkId: string) =>
    sendToPlugin('apply.hunk_status', { pendingId: file.pendingId, hunkId, status: 'REJECTED' });

  return (
    <div className={`file-change ${file.applied ? 'applied' : ''}`}>
      <div className="file-change-header">
        <span className="file-op">{file.op}</span>
        <span className="file-path">{file.path}</span>
        <button onClick={() => sendToPlugin('open_file', { path: file.path })}>在编辑器打开</button>
        {!file.applied ? (
          <>
            <button onClick={() => sendToPlugin('apply.apply_file', { pendingId: file.pendingId })}>应用</button>
            <button onClick={() => sendToPlugin('apply.reject_file', { pendingId: file.pendingId })}>拒绝</button>
            <button onClick={() => sendToPlugin('apply.reapply', { pendingId: file.pendingId })}>重新应用</button>
          </>
        ) : (
          <span className="applied-badge">已应用</span>
        )}
      </div>
      {file.hunks.map(h => (
        <HunkView key={h.id} hunk={h} onAccept={() => accept(h.id)} onReject={() => reject(h.id)} />
      ))}
    </div>
  );
}
```

### 4.3 HunkView(逐 hunk Accept/Reject)

```tsx
export function HunkView({ hunk, onAccept, onReject }: {
  hunk: PendingHunk; onAccept: () => void; onReject: () => void;
}) {
  return (
    <div className={`hunk hunk-${hunk.status.toLowerCase()}`}>
      <div className="hunk-header">
        <span>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
        {hunk.status === 'PENDING' && (
          <>
            <button onClick={onAccept} className="hunk-accept">✓ Accept</button>
            <button onClick={onReject} className="hunk-reject">✗ Reject</button>
          </>
        )}
        {hunk.status === 'ACCEPTED' && <span className="hunk-badge">已接受</span>}
        {hunk.status === 'REJECTED' && <span className="hunk-badge">已拒绝</span>}
        {hunk.status === 'APPLIED'  && <span className="hunk-badge">已落盘</span>}
      </div>
      <pre className="hunk-body">
        {hunk.lines.map((line, i) => {
          const cls = line.startsWith('+') ? 'add'
                    : line.startsWith('-') ? 'del'
                    : 'ctx';
          return <div key={i} className={`hunk-line ${cls}`}>{line}</div>;
        })}
      </pre>
    </div>
  );
}
```

## 5. 与 LLM 对接:smart re-apply

当 `apply.apply_file` 失败(如 hunk 上下文已经因外部编辑漂移),后端:

1. 标记 pendingFile 为 `dirty`
2. 自动发起一个**修复 step**:用 `fast-apply` 模型,prompt = "目标内容如下 +
   当前磁盘内容,产出最小补丁"
3. 替换 hunks,前端 UI 显示 "已自动重新对齐,请复核"

```kotlin
fun smartReapply(pendingId: String) {
  val pf = files[pendingId] ?: return
  val disk = readCurrentDisk(pf.path)
  val newContent = FastApplyModel.realign(
    target = pf.proposedContent,
    current = disk,
    intent = "preserve target semantics",
  )
  pf.hunks.clear()
  pf.hunks.addAll(DiffUtil.unifiedHunks(disk, newContent).mapIndexed { i, h -> h.copy(id = "h$i") })
  emitPending()
}
```

## 6. 验收

1. 一次 turn 含 3 文件、每文件 2 hunk:勾选其中 2 hunk → 应用 → 文件确实只包含
   被勾选的那两个 hunk 的修改。
2. Undo 后,文件内容、磁盘 mtime 与 turn 开始前一致。
3. 在 Apply 前外部手工修改文件 → reapply 自动重对齐;再 Apply 不破坏外部修改。
4. `auto_apply=true` + 全部 LOW 风险:无需点击,文件直接落盘且 UI 显示 "已应用"。
