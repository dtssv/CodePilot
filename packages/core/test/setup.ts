// vitest setup: redirect HOME to a temp dir before session.ts is imported.
// This ensures SESSIONS_DIR lives under our temp dir, not the real ~/.codepilot.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "codepilot-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
// Ensure no provider tries to call out to a real API during tests.
process.env.ANTHROPIC_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.GITHUB_TOKEN = "";
