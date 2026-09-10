/**
 * OpenTelemetry-compatible telemetry (claude-code parity).
 *
 * Lightweight, dependency-free telemetry that emits OTLP/JSON traces over
 * HTTP when configured. Controlled by standard OTEL environment variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — the OTLP collector URL (e.g. http://localhost:4318).
 *   OTEL_SERVICE_NAME            — service name attribute (default: "codepilot").
 *   OTEL_RESOURCE_ATTRIBUTES     — key=value,key=value resource attributes.
 *   OTEL_TRACES_EXPORTER         — "otlp" (default) or "none" to disable.
 *
 * When no endpoint is configured, all telemetry calls are no-ops (zero
 * overhead). This keeps the package dependency-free — we hand-roll the
 * OTLP/HTTP-JSON export instead of pulling in @opentelemetry/*.
 *
 * The session wires key lifecycle events into spans:
 *   - Each `session.prompt()` → a "codepilot.prompt" span
 *   - Each provider stream → a "codepilot.llm_call" child span (with usage)
 *   - Each tool execution → a "codepilot.tool_call" child span
 *   - Errors → span exceptions + error status
 *
 * @module telemetry
 */
import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { URL } from "node:url";
import { hostname } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  /** OTLP collector endpoint (e.g. http://localhost:4318). When unset, telemetry is disabled. */
  endpoint?: string;
  /** Service name (default "codepilot"). */
  serviceName?: string;
  /** Resource attributes parsed from OTEL_RESOURCE_ATTRIBUTES. */
  resourceAttributes: Record<string, string>;
  /** Whether traces are enabled. */
  enabled: boolean;
}

/** Parse OTEL config from environment variables. */
export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const exporter = env.OTEL_TRACES_EXPORTER ?? "otlp";
  const enabled = Boolean(endpoint) && exporter !== "none";
  const resourceAttributes = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? "codepilot",
    resourceAttributes,
    enabled,
  };
}

function parseResourceAttributes(s?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const pair of s.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (key) out[key] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Span model (minimal OTLP-compatible)
// ---------------------------------------------------------------------------

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 0=unspecified, 1=internal, 2=server, 3=client
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; timeUnixNano: string; attributes?: Record<string, unknown> }>;
  status: { code: number; message?: string }; // 0=unset, 1=ok, 2=error
  /** The service.resource for this span. */
  resource: { attributes: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export class Tracer {
  private config: TelemetryConfig;
  private spans: Span[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatchSize = 64;
  private readonly flushDelayMs = 5000;

  constructor(config?: TelemetryConfig) {
    this.config = config ?? loadTelemetryConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Start a new span. Returns the span; call `end(span)` when done. */
  startSpan(
    name: string,
    opts: {
      parentSpanId?: string;
      attributes?: Record<string, string | number | boolean>;
      kind?: number;
    } = {}
  ): Span {
    const traceId = opts.parentSpanId
      ? this.spans.find((s) => s.spanId === opts.parentSpanId)?.traceId ?? randomTraceId()
      : randomTraceId();
    const resourceAttrs: Record<string, string> = {
      "service.name": this.config.serviceName ?? "codepilot",
      "host.name": hostname(),
      ...this.config.resourceAttributes,
    };
    return {
      traceId,
      spanId: randomSpanId(),
      parentSpanId: opts.parentSpanId,
      name,
      kind: opts.kind ?? 1,
      startTimeUnixNano: nowNano(),
      attributes: { ...opts.attributes },
      events: [],
      status: { code: 0 },
      resource: { attributes: resourceAttrs },
    };
  }

  /** End a span and queue it for export. */
  end(span: Span): void {
    if (!this.config.enabled) return;
    span.endTimeUnixNano = nowNano();
    this.spans.push(span);
    if (this.spans.length >= this.maxBatchSize) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.flushDelayMs);
    }
  }

  /** Record an error on a span (sets status to error + adds an exception event). */
  recordError(span: Span, err: Error): void {
    span.status = { code: 2, message: err.message };
    span.events.push({
      name: "exception",
      timeUnixNano: nowNano(),
      attributes: {
        "exception.type": err.name,
        "exception.message": err.message,
        "exception.stacktrace": err.stack ?? "",
      },
    });
  }

  /** Add a structured event to a span. */
  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({ name, timeUnixNano: nowNano(), attributes });
  }

  /** Flush all buffered spans to the OTLP endpoint. */
  async flush(): Promise<void> {
    if (!this.config.enabled || !this.config.endpoint || this.spans.length === 0) return;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const batch = this.spans.splice(0, this.spans.length);
    const payload = buildOtlpRequest(batch);
    try {
      await exportOtlp(this.config.endpoint, payload);
    } catch {
      // Silently drop on export failure — telemetry must never break the session.
    }
  }

  /** For testing: get the count of buffered (unflushed) spans. */
  bufferedCount(): number {
    return this.spans.length;
  }
}

// ---------------------------------------------------------------------------
// OTLP/HTTP-JSON export
// ---------------------------------------------------------------------------

function buildOtlpRequest(spans: Span[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrsToObject(spans[0]?.resource.attributes ?? {}) },
        scopeSpans: [
          {
            scope: { name: "codepilot" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano ?? s.startTimeUnixNano,
              attributes: attrsToObject(s.attributes),
              events: s.events.map((e) => ({
                name: e.name,
                timeUnixNano: e.timeUnixNano,
                attributes: e.attributes ? attrsToObject(e.attributes) : [],
              })),
              status: s.status,
            })),
          },
        ],
      },
    ],
  };
}

function attrsToObject(attrs: Record<string, unknown>): unknown[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: typeof value === "string"
      ? { stringValue: value }
      : typeof value === "number"
        ? { doubleValue: value }
        : { boolValue: value },
  }));
}

function exportOtlp(endpoint: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/traces", endpoint);
    const body = JSON.stringify(payload);
    const isHttps = url.protocol === "https:";
    const req = isHttps
      ? requestHttps(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } })
      : request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
    req.on("response", (res) => {
      res.resume(); // drain
      if ((res.statusCode ?? 0) < 300) resolve();
      else reject(new Error(`OTLP export failed: ${res.statusCode}`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ID + time helpers
// ---------------------------------------------------------------------------

function randomTraceId(): string {
  return randomHex(16);
}

function randomSpanId(): string {
  return randomHex(8);
}

function randomHex(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString("hex");
}

function nowNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

// ---------------------------------------------------------------------------
// Singleton (lazy)
// ---------------------------------------------------------------------------

let _tracer: Tracer | null = null;

/** Get the global tracer (lazily initialized from env). */
export function getTracer(): Tracer {
  if (!_tracer) _tracer = new Tracer();
  return _tracer;
}

/** Replace the global tracer (for testing). */
export function setTracer(t: Tracer | null): void {
  _tracer = t;
}
