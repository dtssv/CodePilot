---
name: security
description: Security audit checklist — OWASP top 10, dependency vulnerabilities, secret patterns, injection vectors, and auth patterns.
when: The user asks for a security audit, vulnerability review, or security hardening check.
tools:
  - read_file
  - grep
  - glob
  - bash
---

# Security Audit Checklist

Load this skill for any security audit. Work the checklist systematically;
record what you checked even when you find nothing (negative results are
evidence of coverage).

## 1. OWASP Top 10 Quick Reference

| ID | Risk | What to look for |
|----|------|------------------|
| A01 | Broken Access Control | Missing authz middleware, IDOR, forced browsing, CORS `*` with credentials |
| A02 | Cryptographic Failures | MD5/SHA1 passwords, ECB mode, hardcoded keys, `rand()`/`Math.random()` for tokens |
| A03 | Injection | Concatenated SQL/shell/HTML, `eval`, unsafe template rendering |
| A04 | Insecure Design | No rate limits on auth, no abuse-case analysis, trust in client-side validation |
| A05 | Misconfiguration | Debug flags, default creds, directory listing, verbose errors to clients |
| A06 | Vulnerable Components | Outdated deps with CVEs — check lockfiles, run audit tools |
| A07 | Auth Failures | Weak session handling, predictable reset tokens, no lockout/MFA |
| A08 | Integrity Failures | Unsafe deserialization, unsigned updates, unverified CI artifacts |
| A09 | Logging Failures | No audit trail for security events; secrets/PII in logs |
| A10 | SSRF | Server fetches built from user input without allowlists |

## 2. Dependency Vulnerability Scanning

Run per-ecosystem auditors; never modify manifests during an audit:

- Node: `npm audit --json` / `pnpm audit` / `yarn audit`
- Python: `pip audit` or cross-reference `requirements*.txt` with OSV
- Go: `govulncheck ./...`
- Rust: `cargo audit`
- Ruby: `bundle audit check`
- Java: OWASP dependency-check (if configured)

Prioritize by: reachable code path > severity > exploit maturity. A critical
CVE in an unused transitive dep ranks below a moderate one in request-path
code. Use `web_search`/`web_fetch` for CVE details when the auditor's
output lacks them.

## 3. Secret Patterns (high-signal regexes)

```
-----BEGIN [A-Z ]*PRIVATE KEY-----
AKIA[0-9A-Z]{16}                    # AWS access key
AIza[0-9A-Za-z_-]{35}               # GCP API key
gh[pousr]_[A-Za-z0-9]{36,}          # GitHub tokens
sk-[A-Za-z0-9]{20,}                 # OpenAI / Stripe secret
xox[baprs]-[A-Za-z0-9-]+            # Slack
-----BEGIN OPENSSH PRIVATE KEY-----
(?i)(password|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']
```

Rules:
- Filter placeholders (`example`, `changeme`, `your-key-here`, env lookups
  like `process.env.*`/`os.environ`).
- **Never print full secret values** — show ≤4 leading chars + `…`.
- Recommend rotation for anything found in committed files (assume
  compromised).

## 4. Injection Vectors — Source → Sink Tracing

For each entry point (route, CLI arg, message, file upload), trace to sinks:

- **SQL**: any query built with `+`/f-strings/template literals → must be
  parameterized/ORM-bound.
- **OS command**: `exec`, `system`, `popen`, `child_process.exec`,
  `subprocess` with `shell=True` → use argv arrays, no shell, allowlist.
- **XSS**: `innerHTML`, `dangerouslySetInnerHTML`, `document.write`,
  template raw-output tags (`{{{ }}}`, `| safe`) → context-aware escaping.
- **Path**: user input into `path.join`/`open`/`fs.*` → normalize, resolve,
  and verify the result stays under an allowed root.
- **Deserialization**: `pickle.loads`, `yaml.load` without SafeLoader, Java
  native serialization, PHP `unserialize`, Node `node-serialize` → reject
  or use safe formats (JSON).
- **SSRF**: `fetch`/`requests`/`axios` of user-derived URLs → parse,
  allowlist hosts/schemes, block link-local & private ranges.
- **Template/SSTI**: user input inside server-side template source (not
  just data) → never render user-controlled template strings.

## 5. Auth & Authorization Patterns

- **Password storage**: bcrypt/argon2id/scrypt only; cost factors sane.
- **Sessions/JWT**: signature verified, `exp` enforced, `alg` not `none`,
  refresh rotation, secure+httponly+samesite cookies.
- **Authorization**: check on *every* object access (not just the list
  view); server-side role checks; deny by default.
- **Rate limiting**: login, reset, OTP, and expensive endpoints throttled.
- **Crypto**: AES-GCM/ChaCha20-Poly1305 for AEAD; random IV per message;
  TLS 1.2+; no `rejectUnauthorized: false` / `verify=False`.

## 6. Severity & Reporting

| Severity | Meaning | Examples |
|----------|---------|----------|
| `[critical]` | Exploitable now, unauthenticated | RCE, SQLi on login, committed live secret |
| `[major]` | Realistic attack with some preconditions | IDOR, stored XSS, weak password hashing |
| `[minor]` | Hardening gap | Missing rate limit, verbose errors |
| `[info]` | Observation | Outdated dep with no known CVE |

Every finding: location, redacted evidence, one-sentence attack scenario,
concrete fix. Close with ranked top risks and quick wins.
