# 10 — Context Budget Breakdown 与多模态输入(P2)

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> ✅ Completed(2026-05-17):`ContextBudgetBar` 已支持分桶 breakdown;`InputBar`
> 支持粘贴图片、拖拽图片/文件/文件夹、语音输入;Kotlin 侧已接入
> `VoiceInputService` 并通过 `context_budget` 下发 breakdown。Java 后端已补齐
> 图片 `raw base64` / `data:` URI 兼容和 `/v1/speech/recognize` 语音识别接口。

## 1. 目标

- **Budget Breakdown**:`ContextBudgetBar` 当前只显示总量,扩展为 stacked bar,
  显示 system / rules / memories / chips / history / tools 各占比,并支持
  "点击 chip 部分逐项移除"。
- **多模态**:支持粘贴图片、拖拽文件夹/文件、语音输入。

## 2. 现状

- `App.tsx:803-809` 仅传 `currentTokens/totalTokens/estimatedTokens`。
- `InputBar.tsx` 仅支持 `ImageAttachment` 点击附件,**未实现 paste 与 drag**。
- 后端 `VoiceInputService.kt` 已存在,但 WebUI 没有调用入口。

## 3. Budget Breakdown

### 3.1 后端

`TokenEstimator.kt` 扩展为分桶统计:

```kotlin
data class BudgetBreakdown(
  val total: Int,                       // 模型 context window
  val used: Int,
  val estimated: Int,                   // 含当前输入框预估
  val buckets: List<Bucket>,
)
data class Bucket(
  val kind: String,                     // system | rules | memories | chips | history | tools | reserve
  val tokens: Int,
  val items: List<BucketItem>,          // 可细粒度展示
)
data class BucketItem(val id: String, val label: String, val tokens: Int, val removable: Boolean)
```

`ConversationClient` 在构建 prompt 时同步算 breakdown,通过 `context.budget` 事件
emit:

```kotlin
fun computeBreakdown(req: UserMessageRequest, history: List<Message>): BudgetBreakdown {
  val sys  = estimator.estimate(systemPrompt)
  val rules = rulesService.activeFor(req.workingFiles()).map { BucketItem(it.id, it.id, estimator.estimate(it.body), false) }
  val mems  = memoryService.accepted().map { BucketItem(it.id, it.content.take(40), estimator.estimate(it.content), false) }
  val chips = req.contextRefs.map { BucketItem(it.id, it.display, estimator.estimate(resolveChipContent(it)), true) }
  val histItems = history.map { BucketItem(it.id, "${it.role}: ${it.content.take(30)}", estimator.estimate(it.content), true) }
  val toolItems = lastTurnTools().map { BucketItem(it.stepId, it.tool, it.tokens, false) }
  return BudgetBreakdown(
    total = modelContextWindow(),
    used = sys + rules.sumOf { it.tokens } + mems.sumOf { it.tokens }
         + chips.sumOf { it.tokens } + histItems.sumOf { it.tokens } + toolItems.sumOf { it.tokens },
    estimated = estimator.estimate(req.draftText),
    buckets = listOf(
      Bucket("system", sys, listOf(BucketItem("sys", "System prompt", sys, false))),
      Bucket("rules", rules.sumOf { it.tokens }, rules),
      Bucket("memories", mems.sumOf { it.tokens }, mems),
      Bucket("chips", chips.sumOf { it.tokens }, chips),
      Bucket("history", histItems.sumOf { it.tokens }, histItems),
      Bucket("tools", toolItems.sumOf { it.tokens }, toolItems),
    ),
  )
}
```

### 3.2 前端

`plugin/webui/src/components/context/BudgetBar.tsx`:

```tsx
const KIND_COLOR: Record<string, string> = {
  system: '#888', rules: '#5b8def', memories: '#9b59b6',
  chips: '#2ecc71', history: '#f39c12', tools: '#e74c3c',
};

export function BudgetBar({ breakdown, onCompress, onRemove }: {
  breakdown: BudgetBreakdown;
  onCompress: () => void;
  onRemove: (kind: string, id: string) => void;
}) {
  const pct = (n: number) => `${(n / breakdown.total * 100).toFixed(1)}%`;
  const usedPct = breakdown.used / breakdown.total;
  const danger = usedPct > 0.85;

  return (
    <div className="budget-bar">
      <div className="budget-track">
        {breakdown.buckets.map(b => (
          <div key={b.kind}
            className="budget-segment"
            style={{ width: pct(b.tokens), background: KIND_COLOR[b.kind] }}
            title={`${b.kind}: ${b.tokens} tokens`} />
        ))}
        <div className="budget-segment estimated"
          style={{ width: pct(breakdown.estimated), background: 'repeating-linear-gradient(45deg,#666,#666 4px,transparent 4px,transparent 8px)' }} />
      </div>
      <div className="budget-text">
        {breakdown.used + breakdown.estimated} / {breakdown.total} tokens
        {danger && <button className="compress-btn" onClick={onCompress}>压缩历史</button>}
      </div>
      <details className="budget-detail">
        <summary>详情</summary>
        {breakdown.buckets.map(b => (
          <div key={b.kind} className="bucket">
            <div className="bucket-header">
              <span className="dot" style={{ background: KIND_COLOR[b.kind] }} />
              <span>{b.kind}</span>
              <span className="muted">{b.tokens}</span>
            </div>
            <ul>
              {b.items.map(it => (
                <li key={it.id}>
                  <span>{it.label}</span>
                  <span className="muted">{it.tokens}</span>
                  {it.removable && (
                    <button onClick={() => onRemove(b.kind, it.id)}>移除</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </div>
  );
}
```

`onRemove` 分派:

```ts
const onRemove = (kind: string, id: string) => {
  if (kind === 'chips')   removeChip(id);
  if (kind === 'history') sendToPlugin('history.remove', { messageId: id });
  if (kind === 'memories') sendToPlugin('memories.reject', { id });
};
```

## 4. 多模态输入

### 4.1 粘贴图片

`InputBar.tsx` 增加 paste handler:

```tsx
const handlePaste = useCallback((e: React.ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imgs: ImageData[] = [];
  for (const it of Array.from(items)) {
    if (it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const data: ImageData = {
          id: `img-${Date.now()}-${imgs.length}`,
          name: blob.name || 'pasted.png',
          mimeType: blob.type,
          base64,
          thumbnail: reader.result as string,
        };
        setAttachedImages(prev => [...prev, data]);
      };
      reader.readAsDataURL(blob);
    }
  }
}, []);
// 挂到 editor:
<div ... onPaste={handlePaste} />
```

### 4.2 拖拽文件 / 文件夹

```tsx
const handleDrop = useCallback(async (e: React.DragEvent) => {
  e.preventDefault();
  const items = e.dataTransfer.items;
  const newChips: ContextChipData[] = [];
  for (const it of Array.from(items)) {
    if (it.kind !== 'file') continue;
    const entry = (it as any).webkitGetAsEntry?.();
    if (!entry) continue;
    if (entry.isDirectory) {
      newChips.push({
        id: `dir-${Date.now()}-${newChips.length}`,
        type: 'folder' as any, display: entry.name, filePath: entry.fullPath,
        language: '', startLine: null, endLine: null,
      });
    } else {
      const file = it.getAsFile()!;
      if (file.type.startsWith('image/')) {
        // 走图片附件
        addImage(file);
      } else {
        newChips.push({
          id: `file-${Date.now()}-${newChips.length}`,
          type: 'file', display: file.name, filePath: file.name /* 待后端解析为绝对路径 */,
          language: '', startLine: null, endLine: null,
        });
      }
    }
  }
  if (newChips.length) {
    sendToPlugin('chips.add', { chips: newChips });   // 后端解析路径并发回 context_added
  }
}, []);

<div className="input-bar"
  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
  onDragLeave={() => setDragOver(false)}
  onDrop={handleDrop}>
  {dragOver && <div className="drag-overlay">松开以引用文件/文件夹</div>}
  ...
</div>
```

后端 `chips.add` 处理:把相对文件名匹配到 workspace 实际路径(若有歧义,
emit 一个 `needs_input` 让用户选);文件夹则递归扫描 + 计算 token 估算后
emit `context_added`(可标记 `tooLarge` 让 UI 高亮提醒)。

### 4.3 语音输入

接入已有 `VoiceInputService.kt`。新增按钮:

```tsx
const [recording, setRecording] = useState(false);

<button className="voice-btn"
  onMouseDown={() => { setRecording(true); sendToPlugin('voice.start', {}); }}
  onMouseUp={() => { setRecording(false); sendToPlugin('voice.stop', {}); }}
  onMouseLeave={() => recording && (setRecording(false), sendToPlugin('voice.stop', {}))}>
  {recording ? '🔴 松开识别' : '🎙️ 按住说话'}
</button>
```

后端在 stop 后:`VoiceInputService.recognize(buffer)` → emit `voice.result`:

```ts
onEnvelope('voice.result', (p) => {
  const { text } = p as { text: string };
  // 追加到编辑器
  editorRef.current!.append(document.createTextNode(text));
});
```

`VoiceInputService.kt` 已有的录制和识别能力直接复用;若尚未通过 SSE 上行到后端,
新增端点:

```kotlin
"voice.start" -> voiceService.startRecording()
"voice.stop"  -> {
  val pcm = voiceService.stopRecording()
  coroutineScope.launch {
    val text = voiceService.transcribe(pcm)
    bus.emit("system", "voice-${System.nanoTime()}", "voice.result", mapOf("text" to text))
  }
}
```

## 5. 验收

1. 粘贴 PNG 截图 → 输入区缩略图出现,发送后模型可读取。
2. 从资源管理器拖入 1 个文件夹 → 自动生成 folder chip,Budget bar 中 chips 段
   增加,详情面板列出所有递归文件;若 token > 8000,chip 标红,可右键移除。
3. 按住语音按钮说一句 → 松开后文字插入到输入框。
4. Budget 详情面板点击单条 history 移除 → 该条 message 不再参与后续轮次。
