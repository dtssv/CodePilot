# Changelog

All notable changes to CodePilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2025-05-06

### Added
- **Backend** (Spring Boot 3.3 + Spring AI 1.0 + Java 21 + Gradle Kotlin DSL + PostgreSQL/pgvector + Redis)
  - Unified `/v1/conversation/run` SSE endpoint (chat + agent).
  - Plan-First multi-turn Agent loop with tool dispatch, self-check, needs-input, risk-notice, task-ledger.
  - 12 built-in tool schemas; SkillRouter with trigger matching; 12 system Skills (yaml).
  - Auth: OIDC Device Flow, HMAC bridge, Dev login; JWT + HMAC + nonce + rate-limit.
  - SystemPromptLeakDetector (pre) + LeakOutputFilter (post); RedactionService.
  - MCP/Skill marketplace API; plugin self-update manifest; install tracking (metadata only).
  - Prometheus custom metrics (`codepilot_*`); OTEL tracing; JSON logs; Flyway V1–V5.
- **Plugin** (Kotlin 2.0 + IntelliJ Platform Plugin 2.x)
  - ToolWindow: Chat + Marketplace tabs; Plan/Ledger panels.
  - 7 editor/project-view Actions with keyboard shortcuts.
  - ToolDispatcher (fs.*, shell.exec), PatchApplier (DiffManager preview), NeedsInput dialog.
  - Login dialog (OIDC/HMAC/Dev); PasswordSafe credentials; RefreshOn401 interceptor.
  - SessionStore (NDJSON); LocalMarketplaceStore (project/global); McpProcessManager (stdio).
  - Reset commands + sentinel scripts; Self-update notification.
- **Deployment**
  - Dockerfile (multi-stage, non-root); docker-compose dev & prod.
  - Helm chart (Deployment/Service/HPA/PDB/Secret).
  - GitHub Actions CI (build/test/image/sign/scan/plugin).
  - SBOM (CycloneDX); cosign keyless signing; Trivy HIGH+CRITICAL gate.
- **Documentation**
  - Design docs (architecture, plugin, backend, prompt, API) in `docs/`.
  - DEPLOY.md, scripts/db/README.md, CONTRIBUTING.md, README.md.

## [Unreleased]
- RAG search integration.
- JCEF Web UI for Chat panel.
- Full hot-patch plugin update.
- Third-party registry integration (UI + well-known protocol).
- Complete MCP ↔ ToolDispatcher bridge.