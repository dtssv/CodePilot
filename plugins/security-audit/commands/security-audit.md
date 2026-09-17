---
description: Run a security audit on a path (dependencies, secrets, injection, auth)
argument-hint: [path]
allowed-tools: [bash, read_file, grep, glob, web_fetch, web_search]
---

# Security Audit

Audit the target: $ARGUMENTS
If no path was given, audit the entire repository root (`.`).

## Phase 1 — Reconnaissance

- `glob` the target for manifests and lockfiles (`package.json`,
  `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`,
  `Pipfile.lock`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`,
  `pom.xml`, `build.gradle*`, `Gemfile.lock`).
- Map the stack: frameworks, auth libraries, ORMs, template engines.
- Identify entry points: HTTP routes, CLI handlers, message consumers,
  file parsers — anywhere untrusted input enters.

## Phase 2 — Dependency Scanning

Run the ecosystem's audit tool on every manifest found:
- Node: `npm audit --json` (or `pnpm audit` / `yarn audit`)
- Python: `pip audit` (if installed) or check against known CVEs
- Go: `govulncheck ./...` (if installed)
- Rust: `cargo audit` (if installed)
- Ruby: `bundle audit` (if installed)

For critical/high findings without a patched version, use `web_search` to
check the CVE/GHSA and note workarounds. Never upgrade dependencies
yourself — report only.

## Phase 3 — Secret Detection

`grep` the target for high-signal secret patterns:
- Private keys: `-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY`
- Cloud creds: `AKIA[0-9A-Z]{16}` (AWS), `AIza[0-9A-Za-z_-]{35}` (GCP),
  `ghp_[A-Za-z0-9]{36}` (GitHub), `sk-[A-Za-z0-9]{20,}` (OpenAI/Stripe sk_),
  `xox[baprs]-` (Slack)
- Generic: `password|passwd|secret|api[_-]?key|token` assigned to string
  literals (filter obvious placeholders like `"changeme"`, env lookups).
- Check `.env`, `config/`, CI files, and git history pointers — but do NOT
  print full secret values in the report; show the first 4 chars + `…`.

## Phase 4 — Injection & Input-Handling Review

Trace untrusted input from entry points to sinks. Check for:
- **SQL**: string concatenation/formatting into queries instead of
  parameterized statements.
- **Shell**: `exec`/`system`/`child_process` with interpolated arguments.
- **XSS**: unescaped user data in HTML/JSX (raw `innerHTML`,
  `dangerouslySetInnerHTML`, unescaped template output).
- **Path traversal**: user input joined into filesystem paths without
  normalization + allowlist checks.
- **Deserialization**: `pickle.loads`, `yaml.load` (non-safe), Java
  `ObjectInputStream`, `unserialize` on untrusted bytes.
- **SSRF**: server-side fetch/HTTP calls whose URLs derive from user input.
- **Eval-equivalents**: `eval`, `new Function`, `Function(...)`, dynamic
  `require`/`import` of user-controlled specifiers.

## Phase 5 — Auth & Authorization Review

- Authentication: password hashing (bcrypt/argon2/scrypt — not MD5/SHA1),
  session/JWT validation, token expiry, secure cookie flags.
- Authorization: every route/handler that touches scoped data must verify
  ownership/roles — look for IDOR (object IDs from the client used without
  checks) and missing middleware on new endpoints.
- Crypto hygiene: no hardcoded keys/IVs, CSPRNG for tokens, TLS enforced
  for external calls, no disabled certificate verification.

## Report Format

Markdown report, findings grouped by phase, each tagged:
`[critical]` exploitable now · `[major]` realistic risk · `[minor]`
hardening · `[info]` observation.

Per finding: `file:line`, quoted snippet (secrets redacted), attack
scenario in one sentence, concrete remediation.

End with a **Summary**: counts per severity, top 3 risks ranked, quick wins
(fixable today), and audit exclusions (unreadable files, skipped tools).
