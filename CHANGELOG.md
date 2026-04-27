# Changelog

All notable changes to CodePilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project scaffolding: backend (Spring Boot 3.3 + Spring AI 1.0 + Java 21 + Gradle Kotlin DSL),
  IDEA plugin (Kotlin + IntelliJ Platform), database migrations (Flyway), Docker/Helm deployment artifacts.
- Unified conversation endpoint `/v1/conversation/run` (SSE) for both Chat and Agent modes.
- Plan-First incremental Agent loop with `selfCheck`, `needsInput`, `riskNotice`, `taskLedger`.
- Skeleton workflow + Skill packages (system-only in backend; user installable to project/global scope).
- Context budgeter (MNI + layered window) to prevent context bloat.
- Plugin self-update (hot-patch preferred, restart fallback) and force-reset commands.
- System prompt leak filter (pre & post) and strict redaction pipeline.