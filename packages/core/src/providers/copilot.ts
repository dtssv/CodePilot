// GitHub Copilot provider.
// Auth: exchange a GitHub token (env GITHUB_TOKEN) for a short-lived Copilot
// API token via https://api.github.com/copilot_internal/v2/token, then call
// https://api.githubcopilot.com/chat/completions (OpenAI-compatible streaming).

import { OpenAIProvider } from "./openai.js";
import type { StreamChatOptions, StreamEvent, ChatProvider } from "./types.js";
import type { OpenAIProviderOptions } from "./openai.js";

export interface CopilotProviderOptions {
  githubToken?: string;
  defaultModel?: string;
  smallModel?: string;
}

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_BASE_URL = "https://api.githubcopilot.com";

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class CopilotProvider implements ChatProvider {
  readonly name = "copilot";
  readonly defaultModel: string;
  readonly smallModel: string;
  private readonly githubToken: string;
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(opts: CopilotProviderOptions = {}) {
    const tok = opts.githubToken ?? process.env.GITHUB_TOKEN;
    if (!tok) {
      throw new Error(
        "CopilotProvider: missing GitHub token. Pass `githubToken` or set GITHUB_TOKEN."
      );
    }
    this.githubToken = tok;
    this.defaultModel = opts.defaultModel ?? "gpt-4o";
    this.smallModel = opts.smallModel ?? "gpt-4o-mini";
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const token = await this.getToken();
    const providerOpts: OpenAIProviderOptions = {
      apiKey: token,
      baseURL: COPILOT_BASE_URL,
      defaultModel: this.defaultModel,
      smallModel: this.smallModel,
    };
    const inner = new OpenAIProvider(providerOpts);
    // Forward all events.
    for await (const ev of inner.stream({ ...opts, model: opts.model })) {
      yield ev;
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.token;
    }
    if (this.inflight) {
      const t = await this.inflight;
      return t.token;
    }
    this.inflight = (async () => {
      const res = await fetch(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
          authorization: `token ${this.githubToken}`,
          accept: "application/json",
          "user-agent": "codepilot",
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Copilot token exchange failed: ${res.status} ${text.slice(0, 200)}`
        );
      }
      const data = (await res.json()) as { token?: string; expires_at?: number };
      if (!data.token) {
        throw new Error("Copilot token exchange: missing token in response");
      }
      const expiresMs =
        typeof data.expires_at === "number"
          ? data.expires_at * 1000
          : now + 25 * 60 * 1000;
      this.cached = { token: data.token, expiresAt: expiresMs };
      return this.cached;
    })();
    try {
      const t = await this.inflight;
      return t.token;
    } finally {
      this.inflight = null;
    }
  }
}
