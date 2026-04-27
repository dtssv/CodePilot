# CodePilot Backend

Spring Boot 3.3 + Spring AI 1.0 + Java 21 + Gradle Kotlin DSL.

## Prerequisites

```bash
# Gradle wrapper bootstrap (run ONCE after checkout)
gradle wrapper --gradle-version 8.10.2 --distribution-type all
```

## Build & Run

```bash
# Dev dependencies
docker compose -f ../scripts/deploy/docker-compose.dev.yml up -d

# Env
cp .env.example .env && set -a && . ./.env && set +a

# Build
./gradlew clean build -x test       # skip tests for fast local

# Run
./gradlew :codePilot-bootstrap:bootRun
```

## Verify

```bash
curl -s http://localhost:8080/actuator/health
curl -s http://localhost:8080/v1/version
```

For full deployment see [../DEPLOY.md](../DEPLOY.md).