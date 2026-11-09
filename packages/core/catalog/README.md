# CodePilot remote catalogs

JSON catalogs fetched by the engine (GitHub raw → `~/.codepilot/catalog/`).

| File | Purpose |
|---|---|
| `connectors.json` | Settings → 连接器 |
| `provider-templates.json` | Settings → 模型服务商模板 |
| `search-engines.json` | Settings → 网络搜索（web_search 引擎模板） |
| `mcp-markets.json` | MCP marketplace browse links |
| `plugins.json` | Plugin marketplace — installable plugin index (discovery entry point) |
| `manifest.json` | Index of catalogs |

Update rule: try once per calendar day; on failure keep the last local copy forever.

`packages/core/catalog/` is the same content, shipped as the offline seed inside `@codepilot/core`. Keep both directories in sync when editing.

`search-engines.json` additionally has an inlined copy in
`packages/core/src/searchEngines.ts` (`INLINE_SEED`) so the seed survives the
Bun `--compile` binary; keep it in sync too.

Override base URL: `CODEPILOT_CATALOG_BASE_URL` (default: this folder on `main`).
