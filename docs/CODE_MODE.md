# code_mode 工具（沙箱代码执行）

> 参考 Anthropic 提出的 "code mode" 思想：对于多步操作（读多个文件 → 转换 → 写回），
> 让模型生成一段 TypeScript/JavaScript 代码一次性执行，比来回多次调用独立工具
> 更省 token、延迟更低，且能利用循环、条件、字符串处理等控制流。
>
> `code_mode` 把模型生成的代码放进 Node.js `vm` 沙箱中执行，并注入一组受控的
> 工具 API（`readFile`、`writeFile`、`editFile`、`bash`、`grep`、`glob`、`ls`）。
> 每个 API 调用都会**路由回正常的工具权限/沙箱管线**——没有任何东西绕过权限引擎。

## 参数

```ts
// packages/core/src/tools/code_mode.ts
const schema = z.object({
  code: string,                       // 要执行的 TS/JS 代码
  timeout_ms?: number,                // 超时（毫秒），默认 30000，最大 120000
});
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `code` | `string` | 是 | — | 要执行的 TypeScript/JavaScript 代码。异步 API 调用用 `await`；最后一个表达式的值会作为返回值；中间输出用 `console.log()` |
| `timeout_ms` | `number`（正整数） | 否 | `30000` | 墙钟超时（毫秒），上限 `120000`。超时后脚本被强制中断 |

工具权限级别为 `execute`（与 `bash` 同级）。

## 沙箱内可用的 API

以下 7 个 async 函数注入到沙箱全局作用域。**它们不是真实文件系统/网络访问**——
每个函数都委托给对应的 CodePilot 工具，照常走权限审批与沙箱检查：

| 沙箱函数 | 签名 | 委托给 | 说明 |
|---|---|---|---|
| `readFile` | `(path: string) => Promise<string>` | `read_file` | 读取文件内容，失败时抛异常 |
| `writeFile` | `(path: string, content: string) => Promise<string>` | `write_file` | 写入文件，失败时抛异常 |
| `editFile` | `(path: string, oldStr: string, newStr: string) => Promise<string>` | `edit_file` | 字符串替换编辑（映射到 `search` / `replace` 参数） |
| `bash` | `(command: string, timeout_ms?: number) => Promise<string>` | `bash` | 执行 shell 命令（`timeout_ms` 映射到 bash 工具的 `timeout`） |
| `grep` | `(pattern: string, path?: string) => Promise<string>` | `grep` | 内容搜索（`path` 映射到 grep 工具的 `cwd`） |
| `glob` | `(pattern: string) => Promise<string>` | `glob` | 文件名模式匹配 |
| `ls` | `(path?: string) => Promise<string>` | `ls` | 列目录，省略 `path` 时列出 cwd |

任何工具返回 `isError: true` 时，对应的沙箱函数会**抛出异常**（消息即工具的错误
内容），代码里可以用 `try/catch` 捕获。

## 安全模型

- **`vm.createContext` 隔离**：代码运行在独立的 V8 上下文中，沙箱对象由
  `Object.create(null)` 创建，只显式注入 7 个 API 函数和一个受控的 `console`。
- **无宿主对象泄漏**：沙箱里**没有** `require`、`process`、`global`、`fetch`、
  `Buffer`、`setTimeout` 等 Node.js 全局对象——访问它们会得到
  `ReferenceError`。
- **禁用代码生成**：创建上下文时设置 `codeGeneration: { strings: false, wasm: false }`，
  因此 `eval()`、`new Function()`、动态 `WebAssembly` 编译在沙箱内全部不可用。
- **权限不旁路**：7 个 API 全部委托给真实工具执行，与模型直接调用这些工具走
  **完全相同的权限/沙箱管线**（`permission: "execute"` 决定 `code_mode` 本身的
  调用门槛，内部每次工具调用仍单独受权限引擎把关）。
- **超时强杀**：`script.runInContext` 带 `timeout`，同步死循环会被 V8 中断。

## 输出

- **`console.log(...)`** → 捕获到 stdout 区块（参数以空格拼接）。
- **`console.error(...)` / `console.warn(...)`** → 捕获到 stderr 区块。
- **最后一个表达式的值**会被包含在结果里：字符串原样返回，其他值用
  `JSON.stringify(v, null, 2)` 格式化（`undefined` 则无输出）。
- 代码被包裹成 `(async () => { ... })()`，因此**顶层 `await` 直接可用**；
  也可以用顶层 `return <值>` 显式指定返回值。
- 无任何输出时返回 `(no output)`。

## 示例

### 1. 批量文件处理

读取所有 markdown 文件并汇总字数统计——一次调用替代 N+1 次工具往返：

```jsonc
{
  "code": "const files = (await glob('docs/*.md')).split('\\n').filter(Boolean);\nconst stats = [];\nfor (const f of files) {\n  const text = await readFile(f);\n  stats.push({ file: f, words: text.split(/\\s+/).length });\n}\nreturn stats;"
}
```

返回（最后表达式的值经 JSON 格式化）：

```json
[
  { "file": "docs/SKILLS.md", "words": 891 },
  { "file": "docs/NOTEBOOK.md", "words": 1204 }
]
```

### 2. 跨文件重构

把多个源文件里的旧导入路径统一替换，并报告每个文件的修改次数：

```jsonc
{
  "code": "const files = (await glob('src/**/*.ts')).split('\\n').filter(Boolean);\nlet total = 0;\nfor (const f of files) {\n  const src = await readFile(f);\n  const count = src.split('from \"@old/utils\"').length - 1;\n  if (count > 0) {\n    await editFile(f, 'from \"@old/utils\"', 'from \"@new/utils\"');\n    console.log(`${f}: ${count} occurrence(s)`);\n    total += count;\n  }\n}\nreturn { filesScanned: files.length, totalReplacements: total };"
}
```

### 3. 数据转换

读取 JSON 配置，转换结构后写回：

```jsonc
{
  "code": "const raw = await readFile('config.json');\nconst cfg = JSON.parse(raw);\nconst migrated = { ...cfg, version: 2, legacy: undefined };\nawait writeFile('config.v2.json', JSON.stringify(migrated, null, 2) + '\\n');\nreturn Object.keys(migrated);"
}
```

### 4. 条件逻辑

按环境条件执行不同命令，失败时回退：

```jsonc
{
  "code": "const hasPnpm = (await bash('command -v pnpm || true')).trim();\nconst pm = hasPnpm ? 'pnpm' : 'npm';\nconsole.log(`using ${pm}`);\ntry {\n  return await bash(`${pm} test -- --run`, 60000);\n} catch (e) {\n  console.error('test run failed, collecting version info');\n  return await bash(`${pm} --version`);\n}"
}
```

## 何时使用 vs 何时不用

| 场景 | 推荐方式 |
|---|---|
| 单次读文件 / 写文件 / 跑命令 | **直接调用对应工具**——`code_mode` 只增加一层包装，没有意义 |
| 多步操作且中间结果需要控制流（循环、条件、字符串处理、聚合） | **`code_mode`**——省掉中间结果回传模型的 token 开销 |
| 任务本身需要完整的多轮对话能力（读文件后让模型再决定下一步） | **`task` 工具**——`code_mode` 里的代码是一次性执行的，无法与模型交互 |
| 需要探索式、结果不可预知的操作 | 直接工具调用或 `task`——`code_mode` 要求模型**事先**写出完整逻辑 |

一句话：`code_mode` 适合"模型已经知道完整流程、只是步骤多"的场景；步骤之间
需要模型判断的，仍应分轮调用工具或委派给 `task`。

## 错误处理

工具失败时返回 `{ content: "...", isError: true }`，不会抛出异常中断会话：

| 场景 | 行为 | 返回示例 |
|---|---|---|
| **语法错误** | `new vm.Script(...)` 编译失败，代码未执行 | `Error: Unexpected token '}'` |
| **运行时错误** | 未捕获的异常（含 API 函数抛出的工具错误）中断执行，已产生的 console 输出仍会返回 | `Error: read_file failed: ENOENT: no such file or directory, ...` |
| **超时** | 超过 `timeout_ms` 后 V8 强制中断脚本 | `Error: Script execution timed out after 30000 ms` |

注意：

- 错误信息取自 `err.message`（堆栈不回传）。
- 运行时错误发生前写入文件的修改**不会回滚**——`code_mode` 不是事务，
  需要原子性时请自行在代码里先全部处理完再统一写盘。
