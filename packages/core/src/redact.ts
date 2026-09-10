// Secret redaction for tool results.
//
// Tool outputs are persisted to the session JSONL, spilled to artifacts,
// and (in older context windows) echoed back to the model. Any credential
// that lands in a tool result is therefore at risk of being replayed or
// leaked. This module applies a conservative pattern set — cloud keys,
// provider API keys, private-key blocks, bearer tokens, passwords inside
// connection strings — and replaces the secret material with a stable
// redaction marker that names the kind of secret without revealing it.
//
// False positives are acceptable (a redacted non-secret is a nuisance; a
// leaked real secret is an incident). Redaction is idempotent.

export interface RedactionPattern {
  name: string;
  re: RegExp;
  /** Replacement; `$1` may reference a capture group to keep context. */
  replace: string;
}

const PATTERNS: RedactionPattern[] = [
  // PEM private key blocks (any flavour).
  {
    name: "private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: "[REDACTED:private-key]",
  },
  // AWS access key id.
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED:aws-access-key]" },
  // Provider tokens. Order matters: the specific shapes first, the catch-all
  // `api-key` pattern last — otherwise "sk-ant-..." would be tagged as a
  // generic api-key.
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED:anthropic-key]" },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED:openai-key]" },
  // GitHub tokens (classic + fine-grained + OAuth + server-to-server).
  { name: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED:github-token]" },
  // Slack tokens.
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED:slack-token]" },
  // Catch-all key-shaped token.
  { name: "api-key", re: /\b(sk|pk|key|api|token)-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED:api-key]" },
  // Bearer tokens in headers.
  { name: "bearer", re: /(authorization\s*[:=]\s*["']?bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replace: "$1[REDACTED:bearer]" },
  // Password inside a connection-string URL: scheme://user:password@host
  { name: "url-password", re: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, replace: "$1[REDACTED:password]$2" },
  // key=value secrets in env-style output.
  {
    name: "env-secret",
    re: /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*["']?[^\s"']{4,}["']?/g,
    replace: "$1=[REDACTED]",
  },
  // JSON-style "password": "value".
  {
    name: "json-secret",
    re: /("(?:password|passwd|secret|token|api_key|apikey|private_key|access_key)"\s*:\s*")[^"]{4,}(")/gi,
    replace: "$1[REDACTED]$2",
  },
];

/** Redact known secret shapes from a tool result string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** True when redaction changed the text (useful for tests/metrics). */
export function containsSecretShape(text: string): boolean {
  return redactSecrets(text) !== text;
}
