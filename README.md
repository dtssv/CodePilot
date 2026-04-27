# CodePilot

> CodePilot 是一个对标 Cursor 的 IDEA AI 编程助手：插件 + 后端 + Skill/MCP 商城。
> 设计文档详见 [`docs/`](docs/)。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/Java-21-orange.svg)](https://adoptium.net/)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.3-brightgreen.svg)](https://spring.io/projects/spring-boot)
[![Spring AI](https://img.shields.io/badge/Spring%20AI-1.0-yellowgreen.svg)](https://docs.spring.io/spring-ai/reference/)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.0-purple.svg)](https://kotlinlang.org/)

---

## 目录结构

```
CodePilot/
├── docs/                                # 设计文档（架构 / 插件 / 后端 / Prompt / 接口）
├── backend/                             # 后端（Spring Boot 3.3 + Spring AI 1.0）
│   ├── codePilot-common/
│   ├── codePilot-core/
│   ├── codePilot-api/
│   ├── codePilot-mcp-hub/
│   ├── codePilot-gateway/
│   ├── codePilot-bootstrap/
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   └── gradle/                          # 版本目录 libs.versions.toml
├── plugin/                              # IDEA 插件（Kotlin + IntelliJ Platform）
│   ├── src/main/kotlin/...
│   ├── src/main/resources/META-INF/plugin.xml
│   ├── build.gradle.kts
│   └── settings.gradle.kts
├── scripts/
│   ├── db/                              # 数据库脚本（Flyway 迁移 + 一次性初始化）
│   │   ├── V1__baseline.sql
│   │   ├── V2__pgvector.sql
│   │   ├── V3__model_registry.sql
│   │   └── V4__audit.sql
│   └── deploy/                          # 部署脚本（Dockerfile / compose / Helm）
├── README.md                            # 本文
├── DEPLOY.md                            # 部署完整说明
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE
```

## 模块概览

| 模块 | 说明 | 入口 |
|---|---|---|
| `backend/` | 统一对话 / Skill 路由 / 上下文预算 / 安全 | `codePilot-bootstrap` |
| `plugin/` | IDEA 客户端，工具体系、Plan/Ledger 面板、SSE 流 | `plugin.xml` |
| `scripts/db/` | Flyway 迁移脚本，**唯一**数据库变更入口 | `V*.sql` |
| `scripts/deploy/` | Dockerfile / docker-compose / Helm 模板 | — |

## 快速开始

### 后端（本地）
```bash
# 1) 启动依赖（Postgres + pgvector / Redis / MinIO）
docker compose -f scripts/deploy/docker-compose.dev.yml up -d

# 2) 运行后端
cd backend
./gradlew :codePilot-bootstrap:bootRun
# 默认监听 :8080，OpenAPI: http://localhost:8080/swagger-ui.html
```

### 数据库
所有变更**只**通过 `scripts/db/V*.sql` 修改，启动时由 Flyway 自动应用。详见 [scripts/db/README.md](scripts/db/README.md)。

### 插件（本地）
```bash
cd plugin
./gradlew runIde      # 启动一个带插件的 IntelliJ 沙箱
./gradlew buildPlugin # 产出 build/distributions/codePilot-*.zip
```

更多见 [DEPLOY.md](DEPLOY.md)。

## 配置

后端通过环境变量配置，**不**包含 mock；任何缺失关键变量都会让应用启动时**显式失败**：

| 变量 | 说明 | 必填 | 示例 |
|---|---|---|---|
| `CODEPILOT_DB_URL` | Postgres JDBC URL | ✓ | `jdbc:postgresql://localhost:5432/codepilot` |
| `CODEPILOT_DB_USER` / `CODEPILOT_DB_PASSWORD` | DB 凭据 | ✓ | — |
| `CODEPILOT_REDIS_URL` | Redis URL | ✓ | `redis://localhost:6379` |
| `CODEPILOT_LLM_BASE_URL` | LLM 上游 baseUrl（OpenAI 协议） | ✓ | `https://api.openai.com/v1` |
| `CODEPILOT_LLM_API_KEY` | LLM 上游 ApiKey | ✓ | — |
| `CODEPILOT_LLM_DEFAULT_MODEL` | 默认模型 | ✓ | `gpt-4o-mini` |
| `CODEPILOT_JWT_SECRET` | JWT 签名密钥（≥32 字节） | ✓ | — |
| `CODEPILOT_HMAC_SECRET` | 设备 HMAC 密钥 | ✓ | — |
| `CODEPILOT_VECTOR_DB` | 向量库选项 `pgvector`（默认） | — | `pgvector` |
| `CODEPILOT_OBJECT_STORAGE_*` | 商城产物对象存储（MinIO/S3） | — | — |

复制 `backend/.env.example` 后填值即可。

## 安全设计要点

- 后端**不持久化**用户会话或代码；仅 hash + 元数据审计。
- system Skill 仅驻后端，永不下发；`SystemPromptLeakFilter` 双向检测。
- 用户的 user Skill / MCP 仅本地存储（项目级 `<projectRoot>/.codePilot/...` 或全局级系统配置目录）。
- `Authorization: Bearer <jwt>` + `X-CodePilot-Signature` HMAC 双层鉴权；时间戳 + nonce 防重放。
- 登录方式：OIDC Device Flow（生产推荐）/ 企业 SSO 桥（HMAC bootstrap token）/ Dev 模式（仅本地）。详见 [DEPLOY.md §3.0](DEPLOY.md#30-关于-ssotoken-的来源)。
- 所有上行内容做正则脱敏；模型输出做"代码注入 / 凭证 / PII / 系统提示词外泄"扫描。

## 开发约定

- **不允许 mock**：开发与测试都使用真实组件（本地 Postgres/Redis），CI 用 Testcontainers。
- **统一日志**：JSON Logback，trace 透传 `X-CodePilot-Trace-Id`；INFO 级别不打印代码内容。
- **代码风格**：Java 用 Spotless + Google Java Format；Kotlin 用 ktlint。
- **提交规范**：Conventional Commits（`feat: ...` / `fix: ...` / `docs: ...`）。

## 许可

[MIT](LICENSE)