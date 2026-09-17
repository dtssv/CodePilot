# notebook_edit 工具（Jupyter Notebook 编辑）

> 参考 claude-code 的 NotebookEdit 机制：Jupyter notebook（`.ipynb`）本质是一个
> JSON 文件（nbformat v4），内容不是纯文本——每个 cell 是一个对象，包含 `cell_type`、
> `id`、`source`（按行拆分的字符串数组）、`metadata`，代码 cell 还带 `outputs` 和
> `execution_count`。直接用 `edit_file` 编辑这个 JSON 很容易破坏结构（source 数组格式、
> 字段遗漏、缩进错位），导致 notebook 无法被 Jupyter 打开。
>
> `notebook_edit` 让模型按 **cell 索引** 操作单个 cell：替换源码、改类型、插入、删除，
> 而不用重写整个文件。notebook 的 JSON 结构（cell ID、metadata、outputs）被保留，
> 只有目标 cell 受影响。

## 参数

```ts
// packages/core/src/tools/notebook_edit.ts
const schema = z.object({
  notebook_path: string,              // .ipynb 文件路径（绝对或相对 cwd）
  cell_index?: number,                // 0-based 索引，replace/delete 必填
  cell_type?: "code" | "markdown" | "raw",
  edit_mode: "insert" | "replace" | "delete" = "replace",
  new_source: string,                 // cell 完整源码（delete 模式忽略）
});
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `notebook_path` | `string` | 是 | — | `.ipynb` 文件路径，可为绝对路径或相对 cwd 的相对路径 |
| `cell_index` | `number`（整数 ≥ 0） | 视模式 | — | `replace` / `delete` 必填：目标 cell 的 0-based 索引。`insert` 模式：新 cell 插入到该索引**之前**（传 `N` 表示追加到末尾，省略同义） |
| `cell_type` | `"code" \| "markdown" \| "raw"` | 否 | `replace` 保持原类型；`insert` 为 `"code"` | `replace` 时省略则不改类型；`insert` 时新 cell 的类型 |
| `edit_mode` | `"insert" \| "replace" \| "delete"` | 否 | `"replace"` | 编辑模式，见下文 |
| `new_source` | `string` | 是 | — | cell 的完整源码，多行字符串直接传。`delete` 模式下被忽略 |

工具权限级别为 `write`（会修改磁盘文件）。

## 编辑模式

### `replace`（默认）

替换 `cell_index` 处 cell 的源码；给了 `cell_type` 则同时改类型：

```jsonc
{
  "notebook_path": "analysis.ipynb",
  "edit_mode": "replace",
  "cell_index": 2,
  "new_source": "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.head()"
}
```

### `insert`

在 `cell_index` **之前**插入一个新 cell。省略 `cell_index` 或传 `N`（cell 总数）即追加到末尾。
`cell_type` 缺省为 `code`：

```jsonc
{
  "notebook_path": "analysis.ipynb",
  "edit_mode": "insert",
  "cell_index": 0,
  "cell_type": "markdown",
  "new_source": "# 数据分析报告\n\n本 notebook 演示数据清洗流程。"
}
```

### `delete`

删除 `cell_index` 处的 cell，`new_source` 被忽略：

```jsonc
{
  "notebook_path": "analysis.ipynb",
  "edit_mode": "delete",
  "cell_index": 5,
  "new_source": ""
}
```

## cell 类型

| 类型 | 用途 | 特有字段 |
|---|---|---|
| `code` | 可执行代码 | `outputs: []`、`execution_count: null` |
| `markdown` | 富文本说明 | 无 outputs / execution_count |
| `raw` | 原文输出（nbconvert 用） | 无 outputs / execution_count |

**类型切换时的字段处理**（仅 `replace` 模式改类型时触发）：

- 改为 `code`：若原 cell 没有 `outputs`，补上 `outputs: []` 与 `execution_count: null`；
  若已有（例如 markdown → code → 又改回来之前的残留），保留原值。
- 改为 `markdown` / `raw`：删除 `outputs` 与 `execution_count` 字段——这两类 cell
  在 nbformat 里不允许带输出。

**插入新 cell 时**：`code` 类型自动带 `outputs: []` 和 `execution_count: null`；
`markdown` / `raw` 不带这两个字段。

## 行为细节

- **cell ID 保留**：`replace` / `delete` 不触碰已有 cell 的 `id`。这对 notebook 的
  diff 工具与版本控制很友好。
- **新 cell ID 生成**：`insert` 用 `crypto.randomUUID()` 生成全局唯一 ID。
- **source 数组格式**：nbformat v4 要求 `source` 是字符串数组——除最后一个元素外，
  每个元素都带结尾 `\n`。工具内部由 `toSourceArray()` 自动完成拆分，调用方只需传
  普通多行字符串；空字符串会得到 `[]`。
- **原子写回**：整个 notebook 在内存中改完后，一次性 `writeFile` 写回（`JSON.stringify`
  缩进 1 空格 + 结尾换行）。不存在"改了一半"的中间状态；写盘失败会返回错误，且明确
  提示 "Cell edited in memory but failed to write notebook"。
- **无关字段原样保留**：`nbformat`、`nbformat_minor`、顶层 `metadata`、各 cell 的
  `metadata` 均不改动。

## 示例

### 1. 替换 code cell 的源码

```jsonc
{
  "notebook_path": "train.ipynb",
  "cell_index": 1,
  "new_source": "model = build_model(lr=1e-4)\nmodel.fit(X_train, y_train, epochs=10)"
}
```

返回：

```
Replaced cell 1 source (3 → 2 line(s)). Notebook has 6 cell(s).
```

### 2. 在开头插入 markdown cell

```jsonc
{
  "notebook_path": "train.ipynb",
  "edit_mode": "insert",
  "cell_index": 0,
  "cell_type": "markdown",
  "new_source": "# 模型训练\n\n记录本次超参搜索过程。"
}
```

返回：

```
Inserted markdown cell at index 0 (id: 3f2a...-...). Notebook now has 7 cell(s).
```

### 3. 在末尾追加 code cell

省略 `cell_index`（或传当前 cell 总数）：

```jsonc
{
  "notebook_path": "train.ipynb",
  "edit_mode": "insert",
  "cell_type": "code",
  "new_source": "model.save('final.h5')"
}
```

返回：

```
Inserted code cell at index 7 (id: 8c1d...-...). Notebook now has 8 cell(s).
```

### 4. 删除一个 cell

```jsonc
{
  "notebook_path": "train.ipynb",
  "edit_mode": "delete",
  "cell_index": 3,
  "new_source": ""
}
```

返回：

```
Deleted cell 3 (type: code, 5 source line(s)). Notebook now has 7 cell(s).
```

### 5. 把 code cell 改成 markdown

`replace` 模式同时传 `cell_type`：

```jsonc
{
  "notebook_path": "train.ipynb",
  "cell_index": 0,
  "cell_type": "markdown",
  "new_source": "## 第一步：加载数据\n\n以下代码从 S3 拉取训练集。"
}
```

返回：

```
Replaced cell 0 source (4 → 2 line(s)), changed type code → markdown. Notebook has 7 cell(s).
```

此时原 cell 的 `outputs` 与 `execution_count` 被删除，`id` 保持不变。

## 错误处理

工具失败时返回 `{ content: "...", isError: true }`，不会抛出异常中断会话：

| 场景 | 返回内容 |
|---|---|
| 文件不存在 / 无法读取 | `Failed to read notebook: ENOENT: no such file or directory, ...` |
| 文件不是合法 JSON | `Failed to read notebook: <JSON parse error>` |
| JSON 里缺少 `cells` 数组 | `Failed to read notebook: invalid notebook: missing or non-array 'cells' field` |
| `replace` / `delete` 索引越界 | `cell_index 5 out of range (notebook has 3 cells)` |
| `insert` 索引越界 | `cell_index 9 out of range for insert (notebook has 3 cells, valid insert range 0..3)` |
| 写盘失败 | `Cell edited in memory but failed to write notebook: <error>` |

注意：越界错误在**写盘前**检测，文件不会被改动。

## 与 edit_file 的取舍

| 场景 | 推荐工具 |
|---|---|
| 编辑 `.ipynb` 的某个 cell（增删改源码、改类型） | `notebook_edit` |
| 普通源码 / 配置 / markdown 文件 | `edit_file` 或 `write_file` |
| 读取 notebook 内容 | `read_file`（返回原始 JSON，自行解析 `cells` 数组） |

为什么不能用 `edit_file` 改 notebook：

1. **source 是数组不是字符串**——`edit_file` 的字符串替换面对的是 JSON 转义后的
   数组字面量，匹配片段极易错位。
2. **结构完整性**——增删 cell 需要同步维护 `id`、代码 cell 的 `outputs` /
   `execution_count`，手工编辑 JSON 容易留下 nbformat 校验不过的结构。
3. **格式归一化**——`notebook_edit` 统一以缩进 1 + 结尾换行写回，diff 干净；
   手工编辑后的文件格式不可控。

反过来，对非 notebook 文件使用 `notebook_edit` 会直接报 JSON 解析错误——它只认
nbformat 结构。
