# Plugins（插件系统）

> 参考 claude-code 的插件机制：插件是一个**可分发、可安装的扩展包**——一个包含
> `plugin.json` 清单文件的目录，里面可以打包 skills、agents、commands、hooks 和
> MCP server 配置。插件在会话启动时被发现，其资源被合并进会话对应的发现路径，
> 让"一组相关能力"可以作为单一单元发布、安装和卸载。

## 插件能装什么

| 资源 | 目录 / 清单字段 | 合并方式 |
|---|---|---|
| Skills（技能） | `skills/` 子目录 | 加入 `discoverSkills` 的 `extraDirs` |
| Agents（自定义子代理） | `agents/` 子目录 | 加入 `discoverCustomAgents` 的 `extraDirs` |
| Commands（slash 命令） | `commands/` 子目录 | 加入 `discoverSlashCommands` 的 `extraDirs` |
| Hooks（生命周期钩子） | 清单里的 `hooks` 字段 | 追加合并进会话 `config.hooks` |
| MCP servers | 清单里的 `mcpServers` 字段 | 按键合并进会话 `config.mcpServers` |
| Agent runtime（agent 循环） | 清单里的 `runtime` 字段 | 动态 import 并注册到 runtime 注册表 |

一个插件可以只含其中任意一种，也可以全部打包。

## 目录结构

```
my-plugin/
├── plugin.json          # 清单（必需）
├── skills/              # 可选：技能包
│   └── my-skill/
│       └── SKILL.md
├── agents/              # 可选：自定义子代理
│   └── reviewer.md
├── commands/            # 可选：slash 命令
│   └── deploy.md
└── …                    # 其他资源文件（脚本、模板等），通过 hooks 引用
```

各资源子目录的格式与全局发现目录完全一致：`skills/*/SKILL.md` 遵循
[SKILLS.md](./SKILLS.md) 规范，`commands/*.md` 遵循 [COMMANDS.md](./COMMANDS.md)
规范，`agents/*.md` 遵循自定义代理规范。

## plugin.json 清单

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 规范插件名（小写、连字符）。发现、安装、卸载都以此为准 |
| `description` | string | **是** | 一行描述 |
| `version` | string | **是** | 版本号（semver） |
| `displayName` | string | 否 | 人类可读的展示名 |
| `author` | string | 否 | 作者或维护者 |
| `homepage` | string | 否 | 主页或仓库 URL |
| `minCodepilotVersion` | string | 否 | 所需的最低 CodePilot 版本 |
| `hooks` | `Record<string, unknown[]>` | 否 | 要注册的钩子，合并进会话 hooks 配置 |
| `mcpServers` | `Record<string, unknown>` | 否 | 要注册的 MCP server，合并进会话 mcpServers 配置 |
| `runtime` | string \| object | 否 | 自定义 agent 循环模块，详见 [RUNTIME.md](./RUNTIME.md) |
| `enabled` | boolean | 否 | 是否启用（默认 `true`）；`false` 时插件被跳过 |

> **校验规则**：缺少 `name` / `description` / `version` 的清单会被静默跳过（fail-soft）。

示例：

```jsonc
{
  "name": "pr-toolkit",
  "displayName": "PR Toolkit",
  "description": "Pull-request review workflows: /review-pr command, reviewer agent, and CI hooks.",
  "version": "1.2.0",
  "author": "team-devtools",
  "homepage": "https://github.com/acme/pr-toolkit",
  "minCodepilotVersion": "0.9.0",
  "hooks": {
    "PostToolUse": [
      { "matcher": "^write_file", "command": "sh ${CLAUDE_PLUGIN_ROOT}/scripts/lint.sh" }
    ]
  },
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": ["--readonly"] }
  }
}
```

## 发现（Discovery）

插件从两个位置被发现，**项目级优先于用户级**：

| # | 来源 | 路径 | `source` |
|---|---|---|---|
| 1 | 项目级 | `<cwd>/.codepilot/plugins/<name>/` | `"project"` |
| 2 | 用户级 | `~/.codepilot/plugins/<name>/` | `"user"` |

规则：

- 同名插件**项目级覆盖用户级**（先扫用户级再扫项目级，后者在 Map 里覆盖前者）。
- 清单里 `enabled: false` 的插件被跳过——可用于临时禁用某个已安装插件而不卸载。
- 缺少 `plugin.json`、JSON 解析失败、或缺必填字段的目录被静默跳过。
- 非目录条目（如散落文件）被跳过。

```ts
import { discoverPlugins } from "@codepilot/core";

const plugins = await discoverPlugins(cwd);
// Map<string, Plugin>，key 为 manifest.name

// 可用选项覆盖默认目录（测试用）：
const plugins2 = await discoverPlugins(cwd, {
  projectDir: "/tmp/proj/.codepilot/plugins",
  userDir: "/tmp/home/.codepilot/plugins",
});
```

`Plugin` 类型：

```ts
interface Plugin {
  manifest: PluginManifest;
  path: string;                    // 插件目录的绝对路径
  source: "project" | "user";
  paths: {                         // 各资源子目录路径（磁盘上可能不存在）
    skills: string;
    agents: string;
    commands: string;
  };
}
```

## 资源合并

发现之后，插件的资源需要显式合并进会话——分两步：

### 1. 目录型资源（skills / agents / commands）

`pluginResourcePaths(plugins)` 汇总所有插件中**实际存在**的资源子目录，
返回的数组可以直接传给对应发现函数的 `extraDirs`：

```ts
import {
  discoverPlugins, pluginResourcePaths,
  discoverSkills, discoverCustomAgents, discoverSlashCommands,
} from "@codepilot/core";

const plugins = await discoverPlugins(cwd);
const extra = pluginResourcePaths(plugins);
// { skills: string[]; agents: string[]; commands: string[] }
// 顺序即优先级：项目插件在前，用户插件在后

const skills   = await discoverSkills(cwd, { extraDirs: extra.skills });
const agents   = await discoverCustomAgents(cwd, { extraDirs: extra.agents });
const commands = await discoverSlashCommands(cwd, { extraDirs: extra.commands });
```

### 2. 配置型资源（hooks / mcpServers）

`mergePluginConfig(config, plugins)` 把清单里的 `hooks` 和 `mcpServers`
合并进会话配置，**返回新对象，不改原对象**：

```ts
import { mergePluginConfig } from "@codepilot/core";

const sessionConfig = mergePluginConfig(config, plugins);
// - hooks：按事件名追加（同一事件的条目拼接，不清空已有配置）
// - mcpServers：按键覆盖合并（后发现的插件覆盖同名 server）
```

合并语义细节：

| 配置 | 语义 |
|---|---|
| `hooks` | 对每个事件名，插件条目**追加**到现有数组末尾；无 hooks 时配置字段保持原样 |
| `mcpServers` | 按键浅合并；同名 server 被后来的插件**覆盖**；无 mcpServers 时字段保持原样 |

### 3. Agent runtime

清单里声明 `runtime` 的插件可以**替换整个 agent 循环**。`createSession()` 会自动
发现并加载：

```ts
import { initPluginRuntimes } from "@codepilot/core";

// createSession 内部就是这一步；手动控制时自己调
const init = await initPluginRuntimes(cwd);
// init.registered    Map<插件名, 注册的 runtime 名>
// init.errors        Map<插件名, 加载失败原因>（fail-soft，不影响其他插件）
// init.defaultRuntime  插件用 `default: true` 声明的 runtime 名
```

runtime 模块在宿主进程中以完整 Node 权限运行（和 hook 脚本同级风险）。
接口、`RuntimeToolkit`、以及 `audit` / `mcts` 两个示例见
[RUNTIME.md](./RUNTIME.md)；可运行的参考插件在 `plugins/runtime-example/`。

## 安装（installPlugin）

```ts
import { installPlugin } from "@codepilot/core";

// 从 git URL 安装（http(s):// 或 git@ 开头 → git clone --depth 1）
await installPlugin("https://github.com/acme/pr-toolkit.git");

// 从本地目录安装（拷贝整个目录；相对路径基于 process.cwd()）
await installPlugin("./packages/pr-toolkit");
await installPlugin("/abs/path/to/pr-toolkit");

// 强制重装（先删除已存在的同名插件）
await installPlugin("https://github.com/acme/pr-toolkit.git", { force: true });
```

行为：

- 目标目录默认为 `~/.codepilot/plugins/<name>/`，`<name>` 由
  `derivePluginName(source)` 推导——git URL 取仓库名（去掉 `.git` 后缀），
  本地路径取目录名。
- 插件**已存在**时抛错，除非 `force: true`。
- 安装完成后校验 `plugin.json` 是否存在；不存在则回滚（删除目录）并抛错。
- `InstallOptions.installDir` 可覆盖目标目录（测试用）。

```ts
interface InstallOptions {
  installDir?: string;  // 覆盖安装目录
  force?: boolean;      // 覆盖已存在的插件
}

// 工具函数：从 URL / 路径推导插件名
derivePluginName("https://github.com/acme/pr-toolkit.git"); // "pr-toolkit"
derivePluginName("./plugins/cool-tool");                    // "cool-tool"
```

## 卸载（uninstallPlugin）

```ts
import { uninstallPlugin } from "@codepilot/core";

const removed = await uninstallPlugin("pr-toolkit");
// true = 找到并删除；false = 未安装
```

卸载即删除 `~/.codepilot/plugins/<name>/` 目录。**注意**：项目级插件
（`<cwd>/.codepilot/plugins/`）不受 `uninstallPlugin` 管理，直接删除目录即可。

## 市场（Marketplace）

市场是一个**静态 JSON 索引**——一个 `MarketplaceEntry` 数组，托管在任意
URL 上（无鉴权、无分页），适合用静态文件服务发布：

```ts
interface MarketplaceEntry {
  name: string;
  description: string;
  source: string;      // git URL 或本地路径，直接传给 installPlugin
  version?: string;
  author?: string;
  tags?: string[];
}
```

索引示例：

```json
[
  {
    "name": "pr-toolkit",
    "description": "Pull-request review workflows",
    "source": "https://github.com/acme/pr-toolkit.git",
    "version": "1.2.0",
    "author": "team-devtools",
    "tags": ["review", "github", "ci"]
  }
]
```

API：

```ts
import { fetchMarketplaceIndex, searchMarketplace, installPlugin } from "@codepilot/core";

// 拉取索引（HTTP GET + JSON 解析；非数组或非 2xx 会抛错）
const index = await fetchMarketplaceIndex("https://plugins.example.com/index.json");

// 搜索：对 name / description / tags 做大小写不敏感的子串匹配
const hits = searchMarketplace(index, "review");

// 一键安装
for (const hit of hits) {
  await installPlugin(hit.source);
}
```

## 完整示例插件

一个包含全部资源类型的插件：

```
pr-toolkit/
├── plugin.json
├── skills/
│   └── pr-review/
│       └── SKILL.md
├── agents/
│   └── reviewer.md
├── commands/
│   └── review-pr.md
└── scripts/
    └── post-edit.sh
```

`plugin.json`：

```json
{
  "name": "pr-toolkit",
  "displayName": "PR Toolkit",
  "description": "PR review workflow: skill + agent + command + lint hook.",
  "version": "1.0.0",
  "author": "acme",
  "hooks": {
    "PostToolUse": [
      { "matcher": "^(write_file|edit_file)$", "command": "sh scripts/post-edit.sh" }
    ]
  }
}
```

`skills/pr-review/SKILL.md`：

```markdown
---
name: pr-review
description: Systematic pull-request review checklist.
when: The user asks to review a PR or diff.
---

# pr-review

1. Fetch the diff (`gh pr diff`).
2. Check correctness, tests, and migration risk.
3. Report findings tagged [blocker] / [major] / [minor] / [nit].
```

`commands/review-pr.md`：

```markdown
---
description: Review a pull request end-to-end.
argument-hint: <pr-number>
allowed-tools: [bash, read_file, grep]
---

Review PR $1 following the pr-review skill checklist.
```

安装后效果：

- `/review-pr 123` 出现在 slash 命令补全里；
- `pr-review` 技能出现在系统提示的技能摘要中，可被 `skill` 工具按需加载；
- `reviewer` 子代理可通过 `task` 工具调用；
- 每次写文件后自动跑 `scripts/post-edit.sh`。

## CLI 集成（`/plugins` 命令）

宿主（TUI / CLI）通常提供一个 `/plugins` slash 命令作为插件管理入口，
内部直接调用上面的 API：

| 用户输入 | 对应调用 |
|---|---|
| `/plugins list` | `discoverPlugins(cwd)`，列出名称、版本、来源（project / user）、启用状态 |
| `/plugins install <source>` | `installPlugin(source)`；重复安装时提示并改用 `{ force: true }` |
| `/plugins uninstall <name>` | `uninstallPlugin(name)` |
| `/plugins search <query>` | `fetchMarketplaceIndex(url)` + `searchMarketplace(index, query)` |
| `/plugins enable/disable <name>` | 编辑对应 `plugin.json` 的 `enabled` 字段（下轮会话生效） |

会话启动时的标准接线顺序：

```ts
// 1. 发现插件（在发现 skills/agents/commands 之前）
const plugins = await discoverPlugins(cwd);

// 2. 合并配置型资源
const config = mergePluginConfig(baseConfig, plugins);

// 3. 合并目录型资源
const extra = pluginResourcePaths(plugins);
const skills   = await discoverSkills(cwd, { extraDirs: extra.skills });
const commands = await discoverSlashCommands(cwd, { extraDirs: extra.commands });
// ...
```

## 设计取舍

- **fail-soft 发现**：坏插件（缺清单、JSON 损坏、字段缺失）一律静默跳过，
  不影响其他插件与会话启动。
- **项目级覆盖用户级**：同名插件项目内可临时覆盖全局安装版本，便于团队
  固定插件版本或本地调试。
- **安装即拷贝/浅克隆**：`--depth 1` 克隆省流量；无插件锁定文件，卸载即删目录。
- **市场极简**：索引只是静态 JSON 数组，任何人都能用静态托管发布市场；
  无鉴权、无签名、无版本解算——信任模型与 `git clone` 一致。
- **资源不过滤权限**：插件的 hooks / MCP server 与手写配置同等对待，
  权限引擎（allow / ask / deny 规则）照常把关。
