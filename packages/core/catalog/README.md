# CodePilot remote catalogs

JSON catalogs fetched by the engine (GitHub raw → `~/.codepilot/catalog/`).

| File | Purpose |
|---|---|
| `connectors.json` | Settings → 连接器 |
| `provider-templates.json` | Settings → 模型服务商模板 |
| `manifest.json` | Index of catalogs |

Update rule: try once per calendar day; on failure keep the last local copy forever.

`packages/core/catalog/` is the same content, shipped as the offline seed inside `@codepilot/core`. Keep both directories in sync when editing.

Override base URL: `CODEPILOT_CATALOG_BASE_URL` (default: this folder on `main`).
