# Integrations: Skills vs MCP

This document clarifies how **Skills** and **MCP** differ in CodePilot, how the IDE WebUI exposes them, and how each request uses them.

## Product split

| | **Skills** | **MCP** |
|---|------------|---------|
| **Purpose** | Extra **prompt / policy text** (and triggers) selected per graph step | **External tools** (stdio/SSE) invoked during agent runs |
| **Install surface** | Skill marketplace / registries → files under `.codepilot/skills` (see plugin `LocalMarketplaceStore`) | `mcp.json` + optional packaged servers under `.codepilot/mcps` |
| **WebUI** | **Skills** + **New skill** tabs: marketplace browse/install + **create local skill** (and IDE wizard). | **MCP** tab: servers, **paste JSON install**, grants, hooks. |
| **Swing tool window** | When JCEF is **off**, **Integrations** tab → `MarketplacePanel` | Same tab → **`McpPanel`** (hooks, grants, installs) |
| **Execution** | No runtime I/O — text is **merged into LLM prompts** when matched | **Always runs in the IDE** via `McpProcessManager` / `ToolDispatcher` (`mcp.*` tool names) |

When **JCEF/WebUI chat** is enabled, the plugin does **not** register this Swing **Integrations** tab — Skill + MCP are only under the embedded **集成** section (single entry point).


There is **no skill execution**: skills do not call processes. MCP does.

## Conversation pipeline (are Integrations wired in?)

| Mechanism | Used where | Evidence |
|-----------|------------|----------|
| **Skills (graph)** | Agent + default graph engine | Request **`userSkillRefs` / `userSkillBodies`** → `IntakeAction` → graph state → `GraphNodeSkillMatcher` per node. **JCEF:** `CefChatPanel` + `SkillRefCollector`. **Swing fallback:** `CodePilotChatPanel` now sends the same (previously it only sent **`userSkills`**, which the graph **does not** read — skills had no effect in Agent mode from Swing). |
| **Skills (chat)** | Single-turn `chat` mode | **`userSkills`** (full yaml) → `SkillRouter` in `ConversationService` (graph off). Swing + JCEF aligned for chat vs agent payload split. |
| **MCP tools in prompts** | Any mode if `mcpTools` present | **`mcpTools`** on request → graph state / prompts. **JCEF:** `ToolDispatcher.initMcpServers()`. **Swing:** same call added to `CodePilotChatPanel`. Execution remains **plugin-local** (`ToolDispatcher` / `mcp.*`). |
| **MCP hooks** | Before each run | **`HookEngine.run("beforeSubmitPrompt", …)`** blocks the stream when a hook fails. **JCEF:** `CefChatPanel` before `client.run`. **Swing:** `runConversationAfterHook()` (including resume-from-needs-input). |
| **beforeShellExecution** | Terminal/shell | `ShellExecutor` invokes `HookEngine` for **`beforeShellExecution`** (separate from chat submit). |

Skill **install** flows (`skill_list`, marketplace UI) write into `LocalMarketplaceStore`; **`SkillRefCollector`** only reads **`activeSkills`** — so installs apply on the next message once the skill is active.

## Request pipeline (plugin → backend)

### Skills (metadata + optional full body)

1. **Plugin** (`SkillRefCollector`): For each **enabled** user skill, applies a **cheap workspace coarse match** (languages/globs/id heuristics). Builds:
   - `userSkillRefs`: metadata + triggers (no large yaml on the wire)
   - `userSkillBodies`: map `id@version` → **full `systemPrompt` text** only for coarse-matched skills
2. **Backend** (`GraphNodeSkillMatcher`): On **each graph node** (planning, repair, …), re-evaluates triggers against `WorkspaceProbe`; only if the skill **matches that node** and a **non-empty body** exists in `userSkillBodies` does it become an `ActivatedSkill` and get a prompt section (`GraphSkillSupport` → `skills_activated` SSE).

So:

- **Coarse filter (IDE)** reduces payload size.
- **Per-node match (server)** decides **whether the skill “hits”** for that step.
- **Full skill text** is only injected when both match and body was sent.

### MCP (metadata vs execution)

1. **Plugin** sends `mcpTools` (tool **schemas** for the model) with the run request (`CefChatPanel`).
2. **Model** may emit `tool_call` with names like `mcp.<server>.<tool>`.
3. **Plugin** `ToolDispatcher` routes those calls to **local** `McpProcessManager#call`; results return over SSE/WebUI. The backend does not execute MCP servers.

## UI consolidation

Previously, **Marketplace** and **MCP** were separate top-level entries in both the WebUI nav and the **IDE tool window** (`CodePilotToolWindowFactory` used to register two contents). They are merged into one **Integrations** surface with sub-tabs **Skills**, **New skill**, and **MCP** (`IntegrationsPanel` in WebUI; `IntegrationsToolPanel` in Kotlin).

**What was removed:** only duplicate **tool window tab labels** — not the underlying panels. `MarketplacePanel` and `McpPanel` are still embedded in full.

### Swing vs WebUI feature parity (managerial)

| Area | WebUI | Swing (tool window) | Notes |
|------|-------|---------------------|--------|
| Skills browse/install | `MarketplacePanel.tsx` + bridge | `MarketplacePanel.kt` | Same store / registries. |
| Create local skill | `CreateSkillPanel.tsx` → `skill.create_local` / `skill.open_wizard` | `NewSkillPanel.kt` / `NewSkillWizard.kt` | Shared `LocalSkillCreator`; wizard still opens as IDE dialog from WebUI. |
| Skill registry list | Browser `localStorage` + optional bridge | `CodePilotSettings` registries | Same catalog **URLs** can diverge until registries are unified. |
| MCP servers | `McpHooksPanel` → `McpService` + **paste JSON** (`mcp.install_json` → `McpJsonInstaller`) | `McpPanel` → same installer | Same `LocalMarketplaceStore` persistence + `reloadConfig`. |
| MCP hooks | `McpHooksPanel` details | `HookConfigPanel` inside `McpPanel` | Same `HookEngine` / `.codepilot/hooks.json`. |

## Related code

- Plugin: `SkillRefCollector.kt`, `SkillMarketplaceBridge.kt`, `LocalSkillCreator.kt`, `McpJsonInstaller.kt`, `McpService.kt`, `ToolDispatcher.kt`, `CefChatPanel.kt` (payload assembly), `IntegrationsToolPanel.kt`, `CodePilotToolWindowFactory.kt`, `HookConfigPanel.kt`
- Backend: `GraphNodeSkillMatcher.java`, `GraphSkillSupport.java`, `ConversationRunRequest` (`userSkillRefs` / `userSkillBodies`)
