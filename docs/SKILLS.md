# Skills（技能系统）

> 参考 claude-code 的 SKILL.md 机制：技能是带 YAML frontmatter 的 markdown 指令包，
> 模型在系统提示里只看到一行摘要，正文按需通过 `skill` 工具加载（progressive disclosure），
> 既节省 token 又保留 prompt cache 命中。

## 文件结构

每个技能是一个目录，目录里放一个 `SKILL.md`：

```
my-skill/
└── SKILL.md
```

`SKILL.md` 由 **YAML frontmatter**（`---` 包围）和 **markdown 正文** 两部分组成。
frontmatter 只识别以下四个键，其他键被忽略：

| 键 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 技能名；缺省时回退为目录名 |
| `description` | 否 | 一行摘要，会出现在系统提示里 |
| `when` | 否 | 触发条件的人类语言描述（也出现在摘要里） |
| `tools` | 否 | 技能会用到的工具名列表（仅用于文档；不强制） |

示例：

```markdown
---
name: commit
description: Generate a Conventional Commits message and create a single logical commit.
when: The user asks to commit, save, or record the current change.
tools:
  - bash
  - read_file
  - grep
---

# commit

Use this skill when the user asks to commit the current change set.

## Workflow
1. Inspect the working tree: `git status --short` ...
2. ...
```

## 发现来源（按优先级）

1. **`<repo>/.codepilot/skills/*/SKILL.md`** — 项目级，最高优先级
2. **`~/.codepilot/skills/*/SKILL.md`** — 用户级
3. **`packages/core/skills/*/SKILL.md`** — 内置，随包发布

同名技能按"第一个定义胜出"覆盖——项目级覆盖用户级，用户级覆盖内置。

### 内置技能

| 名称 | 用途 |
|---|---|
| `commit` | 规范 Conventional Commits 工作流（状态查看 → 分段 → 写消息 → 提交 → 报告 SHA） |
| `review` | 结构化代码审查清单（按严重度标记 `[blocker]`/`[major]`/`[minor]`/`[nit]`） |

内置技能的 markdown 同时嵌入在 `src/skills.ts` 的 `BUILTIN_SKILLS` 常量里，
即使包以扁平形式安装（pnpm / npm），技能仍然可用；当源码树在主机上时，
on-disk 版本优先。

## API

```ts
// packages/core/src/skills.ts
export interface Skill {
  name: string;
  description: string;
  when?: string;
  tools?: string[];
  path: string;             // SKILL.md 的绝对路径
  dir: string;              // 技能目录的绝对路径
  source: "project" | "user" | "builtin";
  body: string;             // frontmatter 剥离后的 markdown 正文
}

export function parseSkillMd(text: string): {
  name?: string;
  description?: string;
  when?: string;
  tools?: string[];
};

export async function discoverSkills(
  cwd: string,
  opts?: DiscoverOptions | string[]
): Promise<Skill[]>;

export function matchSkill(skills: Skill[], query: string): Skill | null;
export function findSkill(skills: Skill[], name: string): Skill | null;
export function skillsPromptSection(skills: Skill[]): string;
export function defaultBuiltinSkillsDir(): string;
export const BUILTIN_SKILLS: ReadonlyArray<{ name: string; markdown: string }>;
```

### `DiscoverOptions`

```ts
interface DiscoverOptions {
  projectDir?: string;      // 覆盖项目级目录
  userDir?: string;         // 覆盖用户级目录
  builtinDir?: string;      // 覆盖内置目录
  extraDirs?: string[];     // 额外扫描路径（解析为绝对路径后按 project 优先级）
}
```

兼容旧调用：`discoverSkills(cwd, ["some/extra/dir"])` 等价于
`discoverSkills(cwd, { extraDirs: ["some/extra/dir"] })`。

## `skill` 工具

```ts
// packages/core/src/tools/skill.ts
export const skillTool: ToolDef<{
  name: string;             // 要加载的技能名
}>;

export function createSkillTool(): SkillToolHandle;
export class StaticSkillStore implements SkillStore;

export interface SkillStore {
  list(): readonly Skill[];
  byName(name: string): Skill | null;
}
```

会话层通常这样接入：

```ts
import { discoverSkills, skillsPromptSection } from "@codepilot/core";
import { skillTool, StaticSkillStore, createSkillTool } from "@codepilot/core";

// 1. 发现技能
const skills = await discoverSkills(cwd);

// 2. 把摘要拼进系统提示（短，省 token）
const skillsSection = skillsPromptSection(skills);

// 3. 给 skill 工具装一个确定的 store
const handle = createSkillTool();
handle.setStore(new StaticSkillStore(skills));

// 4. 注册 skill 工具，注册时把摘要拼到 system prompt 里
registry.register(handle.tool);
```

工具输入：

```jsonc
{ "name": "commit" }
```

工具返回（成功时）：

```
# skill: commit
source: builtin
path: /.../skills/commit/SKILL.md
when: The user asks to commit, save, or record the current change.
description: Generate a Conventional Commits message ...

Use this skill when the user asks to commit the current change set.

## Workflow
1. ...
```

未找到技能时返回 `isError: true` 与一行提示。

匹配规则（由 `matchSkill` / `findSkill` 实现）：

1. 精确匹配 `name`（大小写敏感）；
2. 精确匹配 `name`（大小写不敏感）；
3. `query` 是 `name` 的子串；
4. `query`（去除空白后的小写形式）出现在 `name` / `description` / `when` 中。

## 设计取舍

- **不引入 YAML 解析器**：手写最小 frontmatter 解析，依赖零、bundle 小。代价是不支持
  多行值、锚点、引用——这些场景对一个技能摘要来说不需要。
- **Progressive disclosure**：系统提示里只放 `name + description`（最多一行），
  正文通过工具按需加载。前缀稳定 → Anthropic / OpenAI 的 prefix cache 命中率不变。
- **Fail-soft 发现**：某个目录读不到就跳过；同名技能第一个胜出，不抛错。
- **技能正文不可信**：模型拿到正文后，权限边界照常生效（`skill` 是 `read` 级权限，
  不直接执行任何命令——模型按正文指示再调用 `bash` 等工具，权限引擎仍然把关）。
