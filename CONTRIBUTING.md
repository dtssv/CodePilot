# Contributing

Thanks for considering contributing to **CodePilot**.

## Ground rules

- **No mocks in production code.** Tests use real services via Testcontainers.
- **No secrets in code or commits.** Use environment variables / vaults.
- **Backward compatibility** for public API and DB schemas; bump major version otherwise.
- All commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(core): add SkillRouter`).

## Workflow

```bash
# 1. Fork & clone
git clone git@github.com:<you>/CodePilot.git
cd CodePilot

# 2. Install pre-requisites
#  - JDK 21+ (Temurin recommended)
#  - Docker Desktop or compatible
#  - IntelliJ IDEA 2024.2+ for plugin development

# 3. Boot infra (Postgres + Redis + MinIO)
docker compose -f scripts/deploy/docker-compose.dev.yml up -d

# 4. Build & run
cd backend && ./gradlew clean build
./gradlew :codePilot-bootstrap:bootRun

# 5. Plugin (in another terminal)
cd plugin && ./gradlew runIde
```

## Code style

| Language | Tool |
|---|---|
| Java | Spotless (Google Java Format) |
| Kotlin | ktlint |
| SQL | sqlfluff (PostgreSQL dialect) |
| Markdown | Prettier |

Run `./gradlew spotlessApply` (backend) and `./gradlew ktlintFormat` (plugin) before committing.

## Tests

| Type | Where | How to run |
|---|---|---|
| Unit | `*/test/...Test.java` | `./gradlew test` |
| Integration | `*/integrationTest/...IT.java` | `./gradlew integrationTest` |
| Plugin UI | `plugin/src/test/...` | `./gradlew :plugin:test` |
| End-to-end | `e2e/` (Playwright + IntelliJ headless) | `./gradlew :e2e:e2eTest` |

CI uses Testcontainers, no mocks allowed in `core` and `api` modules.

## Reporting issues

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Include reproduction steps, expected vs actual,
plugin / backend versions, OS, model name (no API keys, please).