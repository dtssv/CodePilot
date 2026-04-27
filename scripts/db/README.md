# scripts/db — Database migrations

This directory is the **single source of truth** for the CodePilot database schema.

## Rules

- Each file is a Flyway-style migration: `V<version>__<description>.sql`.
- **Never modify** an already-released `V*` file; add `V(n+1)__...` instead.
- PostgreSQL 16+ is required (uses `pgcrypto`, `citext`, and `vector`).
- SQL style: lowercase DDL, snake_case, explicit `ON DELETE` clauses, and comments on non-obvious tables.

## Layout

```
scripts/db/
├── V1__baseline.sql          # tenants / users / devices / custom_model_providers / idempotency
├── V2__pgvector.sql          # RAG chunks (pgvector, 24h TTL)
├── V3__marketplace.sql       # MCP / Skill packages + install records + plugin releases
├── V4__audit.sql             # audit_events + system_leak_events
└── README.md                 # this file
```

## How migrations are applied

- At runtime: Flyway ships inside `codePilot-bootstrap` and applies migrations on startup.
  Path: `classpath:db/migration/` (auto-synced from this directory at build time).
- In CI: the same scripts are applied to Testcontainers PostgreSQL; tests fail if any migration fails.
- Ad-hoc: `flyway -url=... -user=... -password=... -locations=filesystem:scripts/db migrate`

## Running locally

```bash
# Spin up Postgres with pgvector
docker compose -f scripts/deploy/docker-compose.dev.yml up -d postgres

# Apply migrations (embedded in the backend)
cd backend
./gradlew :codePilot-bootstrap:flywayMigrate
```

## Rolling back

Flyway does not do automatic rollbacks. For urgent rollbacks:
1. Add a `V(n+1)__rollback_xxx.sql` that reverses the change.
2. If that is impossible, restore from backup.

## Data retention & privacy

- `rag_chunks` auto-expires after 24 hours (scheduled cleanup job in `codePilot-core`).
- `audit_events.message`, `args_hash` never contain plaintext user code or credentials.
- `system_leak_events.sample_excerpt` stores at most a 200-char *redacted* excerpt for forensics.

When in doubt, **do not** store the raw value — store a SHA-256 hash plus pointers.