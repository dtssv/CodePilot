# Bundle（配置包导出 / 导入）

> Bundle 是一个**自包含的 JSON 文件**，把复现一套 CodePilot 环境所需的一切
> 打包在一起：解析后的配置 + 自定义 commands + agents + skills。
> 一台机器上 `bundle export`，另一台机器上 `bundle import`，即可得到完全一致的
> 使用环境。源码见 `packages/core/src/bundle.ts`。

## TL;DR

```bash
# 导出（默认写到 ./codepilot-bundle.json）
codepilot bundle export ./my-bundle.json

# 带上 profile / patch 一起导出
codepilot bundle export ./prod.json --profile prod
codepilot bundle export ./tuned.json --config-patch '{"model":"gpt-5","maxTurns":80}'

# 在另一台机器上导入
codepilot bundle import ./my-bundle.json
```

导入后：

| 内容 | 落盘位置 |
|---|---|
| `config` | `~/.codepilot/config.json` |
| `commands` | `~/.codepilot/commands/*.md` |
| `agents` | `~/.codepilot/agents/*.md` |
| `skills` | `~/.codepilot/skills/<name>/*.md` |

## Bundle 格式

Bundle 是单个 JSON 对象，顶层固定 5 个键（`BUNDLE_VERSION = 1`）：

```json
{
  "version": 1,
  "config": {
    "provider": "openai",
    "model": "gpt-5-mini",
    "permissionMode": "auto-edit",
    "maxTurns": 50
  },
  "commands": {
    "review.md": "# Review\n\n$ARGUMENTS"
  },
  "agents": {
    "explore.md": "---\nname: explore\ndescription: Explore code\n---\nBody."
  },
  "skills": {
    "pdf/SKILL.md": "# PDF skill"
  }
}
```

| 键 | 类型 | 说明 |
|---|---|---|
| `version` | `number` | 格式版本，当前恒为 `1`；导入时不匹配的版本直接报错 |
| `config` | `object` | **完整解析后**的配置（各层合并 + profile + patch 之后的最终值），导入时原样写入 `~/.codepilot/config.json` |
| `commands` | `Record<string, string>` | 命令文件名（如 `review.md`）→ markdown 内容 |
| `agents` | `Record<string, string>` | agent 文件名（如 `explore.md`）→ markdown 内容 |
| `skills` | `Record<string, string>` | 技能路径（如 `pdf/SKILL.md`，允许一层子目录）→ markdown 内容 |

说明：

- 资源键是**相对文件名**；`skills` 的键允许带一层路径段（`<name>/SKILL.md`）。
- `commands` / `agents` / `skills` 的值必须是字符串（文件内容原文）。
- 序列化输出为 2 空格缩进的 pretty JSON 并以换行结尾（`serializeBundle`）。

## 导出（Export）

### API

```ts
import {
  exportBundle, exportBundleToFile, serializeBundle,
  type CodepilotBundle, type ExportBundleOptions,
} from "@codepilot/core";

// 1) 构建 bundle 对象（不落盘）
const bundle = await exportBundle({
  cwd: process.cwd(),          // 按哪个目录解析配置（默认 process.cwd()）
  includeProject: true,        // 是否包含项目级资源（默认 true）
  profile: "prod",             // 等价于 --profile
  patch: { model: "gpt-5" },   // 等价于 --config-patch
});

// 2) 序列化为 JSON 字符串
const json = serializeBundle(bundle);

// 3) 一步到位：导出并写盘（自动创建父目录）
await exportBundleToFile("./codepilot-bundle.json", { profile: "prod" });
```

`ExportBundleOptions`：

| 选项 | 默认 | 说明 |
|---|---|---|
| `cwd` | `process.cwd()` | 以此目录解析分层配置、定位项目级资源 |
| `includeProject` | `true` | 是否收集项目级（`<cwd>/.codepilot`）资源 |
| `profile` | — | 导出前激活该 profile（同 `--profile`） |
| `patch` | — | 导出前应用该 JSON merge-patch（同 `--config-patch`） |
| `homeDir` | `os.homedir()` | 覆盖 home 目录（主要用于测试） |

### 收集范围

导出时按以下顺序收集 `.md` 资源，**先用户级、后项目级，同名时项目级覆盖用户级**
（与运行时的资源优先级一致）：

| 顺序 | 目录 | 层级 |
|---|---|---|
| 1 | `~/.codepilot/commands` `agents` `skills` | 用户级 |
| 2 | `<cwd>/.codepilot/commands` `agents` `skills` | 项目级（`includeProject: false` 时跳过） |

- 只收集 `.md` 文件；`skills` 目录会多扫描一层子目录，键为 `<子目录>/<文件>.md`。
- 条目按键名排序，保证同一份环境导出的 bundle 字节级确定（diff 友好）。
- `config` 字段是 `loadConfigWithSources()` 的完整解析结果（defaults < managed
  < user < repo < env < caller < profile < patch），导出前会剥掉 `undefined`，
  保证 bundle 是干净的 JSON。

## 导入（Import）

### API

```ts
import {
  importBundle, importBundleFromFile, parseBundle, validateBundle,
  type ImportBundleResult,
} from "@codepilot/core";

// 1) 从文件读取、校验并导入
const result: ImportBundleResult = await importBundleFromFile("./my-bundle.json");
// → { configPath: "/home/u/.codepilot/config.json", commands: 1, agents: 1, skills: 1 }

// 2) 也可以手动 parse / validate 后再导入
const bundle = parseBundle(jsonText);   // 解析 + 校验，非法输入抛错
await importBundle(bundle, { homeDir }); // homeDir 仅测试用
```

### 导入行为

1. `config` → 写入 `~/.codepilot/config.json`（pretty JSON，自动创建目录）。
2. `commands` / `agents` / `skills` 的每个条目 → 写入
   `~/.codepilot/{commands,agents,skills}/<键名>`，父目录按需创建。
3. 返回 `ImportBundleResult`：配置写入路径 + 各类资源的写入文件数。

注意：

- 导入一律写到**用户级**目录；bundle 里不区分条目来自用户级还是项目级。
- 同名已存在的文件会被**覆盖**；bundle 中不存在的旧文件不会被删除（导入不是
  同步，只是写入）。
- 导入在解析阶段就做完整校验（版本、`config` 必须是对象、资源值必须是字符串、
  资源键必须安全），任何一项不合格都会抛错，**不会写一半**。

## CLI 用法

TUI 二进制的 `bundle` 子命令（见 `apps/tui/src/cli.tsx` 的 `runBundle`）：

```bash
codepilot bundle export [path]   # 默认 ./codepilot-bundle.json
codepilot bundle import <path>   # path 必填
```

`export` 支持全局的 `--profile` / `--config-patch` / `--cwd` 标志
（子命令参数原样保留，因此 bundle 路径即使以 `-` 开头也不会被当成 flag）：

```bash
# 导出 prod profile 合并后的配置
codepilot bundle export ./prod.json --profile prod

# 导出时临时覆盖两个字段
codepilot bundle export ./tuned.json --config-patch '{"model":"gpt-5","maxTurns":80}'

# 成功输出示例
# Exported bundle to /abs/path/prod.json (3 commands, 1 agents, 2 skills)
# Imported bundle: config -> /home/u/.codepilot/config.json, 3 commands, 1 agents, 2 skills
```

退出码：`0` 成功；`1` 失败（缺 core、读写或校验错误）；`2` 用法错误
（如 `import` 缺路径、未知 action）。

## Profile 集成

`exportBundle({ profile: "prod" })` 与 CLI 的 `--profile prod` 等价：导出前先把
配置里的 `profiles.prod` 合并到基础配置上，**bundle 捕获的是 profile 合并后的
最终配置**。

```jsonc
// ~/.codepilot/config.json
{
  "model": "base-model",
  "profiles": {
    "prod": { "model": "prod-model", "permissionMode": "ask" }
  }
}
```

```bash
codepilot bundle export ./prod.json --profile prod
# prod.json 里 config.model === "prod-model"
```

要点：

- 完整的组合顺序是 `defaults < managed < user < repo < env < caller < profile < patch`，
  profile 在所有常规层之上、patch 之下。
- 显式 `--profile` 胜过配置里的 `activeProfile` 和 `CODEPILOT_PROFILE` 环境变量。
- profile 是扁平的：profile 内再写 `profiles` / `activeProfile` 会被忽略
  （一个 profile 不能再激活另一个 profile）。
- profile 不存在时报错并列出所有已知 profile 名。
- 因为 bundle 捕获的是合并结果，**导入方不需要定义同名 profile**——配置是
  自包含的。

## Config Patch 集成

`exportBundle({ patch })` / `--config-patch '<json>'` 在 profile 组合**之后**再
应用一层 JSON merge-patch（RFC 7386 风格），是导出前的"最后一句话"：

```bash
codepilot bundle export ./tuned.json \
  --profile prod \
  --config-patch '{"model":"gpt-5","logging":{"level":"debug"},"apiKey":null}'
```

合并语义：

| patch 值 | 效果 |
|---|---|
| 对象 | 与 base 递归按键合并 |
| 标量 / 数组 | **整体替换**（patch 数组不与 base 拼接——这点不同于分层配置的 `autoApprove` 拼接） |
| `null` | 从 base 中**删除**该键（上面的例子会抹掉 `apiKey`） |

patch 应用后仍会走 env 插值和 schema 校验，非法值（如
`{"permissionMode":"lol"}`）会以 `Invalid CodePilot config` 报错，导不出脏 bundle。

典型用途：导出一份给团队分发的 bundle 时，用 patch 抹掉本机的 `apiKey`、
临时调高 `maxTurns`、或固定一个模型版本。

## 安全

Bundle 是"读 JSON → 写文件"的机制，恶意构造的 bundle 可能尝试把文件写到
目标目录之外。两道防线（都在 `bundle.ts` 内）：

1. **资源键校验（`assertSafeResourceName`）**——在 `parseBundle` /
   `validateBundle` 阶段就拒绝危险键名，`importBundle` 永远看不到坏名字。
   以下形式的键一律抛 `Invalid bundle: unsafe resource name`：
   - 空字符串
   - 绝对路径（`/etc/passwd`、`C:\…` 等盘符开头）
   - 含 `..` 路径段（`../../etc/passwd.md`）
2. **落盘前二次确认（`safeJoin`）**——拼接后的目标路径必须仍位于目标目录
   （`~/.codepilot/commands|agents|skills`）之内，否则抛
   `resource name escapes target directory`。

此外：

- 版本不匹配（`version !== 1`）直接拒绝，避免旧格式被误读。
- `config` 非对象、资源值非字符串都会在导入前抛错。
- 导入路径被限制在 `~/.codepilot/` 下的固定子目录，bundle 无法指定其它落盘位置。

## 使用场景

| 场景 | 做法 |
|---|---|
| **团队入职** | 老成员 `bundle export team.json --config-patch '{"apiKey":null}'` 后提交到内部仓库；新成员 `bundle import` 即可获得统一的 commands / agents / skills / 模型配置 |
| **CI/CD 配置分发** | CI 镜像构建时 `codepilot bundle import ci.json`，保证流水线里的 headless 运行（`-p` 模式）与本地配置一致 |
| **备份 / 恢复** | 定期 `bundle export ~/backups/cp-$(date +%F).json`；重装系统后一条 `bundle import` 恢复全部环境 |
| **多机同步** | 在主力机上导出，拷贝（或走 dotfiles 仓库 / syncthing）到其它机器导入；配合 `--profile` 还能给"工作机 / 家用机"分别导出不同配置 |
| **项目模板** | 项目仓库放一份 `bundle.json`（`includeProject` 已把 `.codepilot/` 资源打进去），协作者导入后即拥有项目专属命令和技能 |

## 相关

- 配置分层与 profile/patch 组合的细节见 [CONFIG.md](./CONFIG.md)。
- skills 的目录结构与发现优先级见 [SKILLS.md](./SKILLS.md)。
- 测试参考 `packages/core/test/configProfiles.test.ts` 的
  `bundle export/import` 套件（roundtrip、项目级覆盖、profile 导出、
  path traversal 拒绝等）。
