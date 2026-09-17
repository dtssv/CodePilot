import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  loadTelemetryConfig,
  Tracer,
  getTracer,
  setTracer,
  type Span,
  type TelemetryConfig,
} from "../src/telemetry.js";

function enabledConfig(endpoint: string, extra: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    endpoint,
    serviceName: "codepilot-test",
    resourceAttributes: {},
    enabled: true,
    ...extra,
  };
}

function disabledConfig(extra: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    endpoint: undefined,
    serviceName: "codepilot-test",
    resourceAttributes: {},
    enabled: false,
    ...extra,
  };
}

describe("loadTelemetryConfig", () => {
  it("parses OTEL_EXPORTER_OTLP_ENDPOINT and defaults", () => {
    const cfg = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    } as NodeJS.ProcessEnv);
    expect(cfg.endpoint).toBe("http://localhost:4318");
    expect(cfg.enabled).toBe(true);
    expect(cfg.serviceName).toBe("codepilot"); // default
    expect(cfg.resourceAttributes).toEqual({});
  });

  it("falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", () => {
    const cfg = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4319",
    } as NodeJS.ProcessEnv);
    expect(cfg.endpoint).toBe("http://localhost:4319");
    expect(cfg.enabled).toBe(true);
  });

  it("prefers OTEL_EXPORTER_OTLP_ENDPOINT over the traces-specific one", () => {
    const cfg = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://primary:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://secondary:4318",
    } as NodeJS.ProcessEnv);
    expect(cfg.endpoint).toBe("http://primary:4318");
  });

  it("is disabled when no endpoint is configured", () => {
    const cfg = loadTelemetryConfig({} as NodeJS.ProcessEnv);
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled when OTEL_TRACES_EXPORTER=none even with an endpoint", () => {
    const cfg = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_TRACES_EXPORTER: "none",
    } as NodeJS.ProcessEnv);
    expect(cfg.endpoint).toBe("http://localhost:4318");
    expect(cfg.enabled).toBe(false);
  });

  it("respects OTEL_SERVICE_NAME", () => {
    const cfg = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_SERVICE_NAME: "my-service",
    } as NodeJS.ProcessEnv);
    expect(cfg.serviceName).toBe("my-service");
  });

  it("parses OTEL_RESOURCE_ATTRIBUTES into a key/value record", () => {
    const cfg = loadTelemetryConfig({
      OTEL_RESOURCE_ATTRIBUTES: "env=prod, region = us-east-1 ,version=1.2.3",
    } as NodeJS.ProcessEnv);
    expect(cfg.resourceAttributes).toEqual({
      env: "prod",
      region: "us-east-1",
      version: "1.2.3",
    });
  });

  it("ignores malformed resource attribute pairs", () => {
    const cfg = loadTelemetryConfig({
      OTEL_RESOURCE_ATTRIBUTES: "good=1,no-equals-sign,=no-key,also=2",
    } as NodeJS.ProcessEnv);
    expect(cfg.resourceAttributes).toEqual({ good: "1", also: "2" });
  });
});

describe("Tracer (enabled)", () => {
  let tracer: Tracer;

  beforeEach(() => {
    // Endpoint doesn't matter here; nothing is flushed in these tests.
    tracer = new Tracer(enabledConfig("http://127.0.0.1:1"));
  });

  afterEach(async () => {
    await tracer.flush();
  });

  it("startSpan creates a valid span structure", () => {
    const span = tracer.startSpan("test.span", {
      attributes: { "foo": "bar", "count": 3, "flag": true },
    });
    expect(span.name).toBe("test.span");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.kind).toBe(1); // internal by default
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toBeUndefined();
    expect(span.attributes).toEqual({ foo: "bar", count: 3, flag: true });
    expect(span.events).toEqual([]);
    expect(span.status).toEqual({ code: 0 });
    expect(span.resource.attributes["service.name"]).toBe("codepilot-test");
    expect(typeof span.resource.attributes["host.name"]).toBe("string");
  });

  it("startSpan respects an explicit kind and resource attributes from config", () => {
    const t = new Tracer(
      enabledConfig("http://127.0.0.1:1", { resourceAttributes: { env: "test" } })
    );
    const span = t.startSpan("client.span", { kind: 3 });
    expect(span.kind).toBe(3);
    expect(span.resource.attributes["env"]).toBe("test");
  });

  it("end() sets endTimeUnixNano and queues the span", () => {
    const span = tracer.startSpan("op");
    expect(tracer.bufferedCount()).toBe(0);
    tracer.end(span);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    expect(BigInt(span.endTimeUnixNano!)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    expect(tracer.bufferedCount()).toBe(1);
  });

  it("bufferedCount tracks unflushed spans", () => {
    tracer.end(tracer.startSpan("a"));
    tracer.end(tracer.startSpan("b"));
    expect(tracer.bufferedCount()).toBe(2);
    tracer.end(tracer.startSpan("c"));
    expect(tracer.bufferedCount()).toBe(3);
  });

  it("recordError sets error status and adds an exception event", () => {
    const span = tracer.startSpan("failing");
    const err = new Error("boom");
    tracer.recordError(span, err);
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe("boom");
    expect(span.events).toHaveLength(1);
    const evt = span.events[0];
    expect(evt.name).toBe("exception");
    expect(evt.timeUnixNano).toMatch(/^\d+$/);
    expect(evt.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "boom",
    });
    expect(typeof evt.attributes!["exception.stacktrace"]).toBe("string");
  });

  it("addEvent appends structured events", () => {
    const span = tracer.startSpan("op");
    tracer.addEvent(span, "cache_hit", { key: "user:1" });
    tracer.addEvent(span, "retry");
    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("cache_hit");
    expect(span.events[0].attributes).toEqual({ key: "user:1" });
    expect(span.events[1].name).toBe("retry");
    expect(span.events[1].attributes).toBeUndefined();
  });
});

describe("Tracer (disabled)", () => {
  it("end() is a no-op: no timestamp, no buffering", () => {
    const tracer = new Tracer(disabledConfig());
    const span = tracer.startSpan("op");
    tracer.end(span);
    expect(span.endTimeUnixNano).toBeUndefined();
    expect(tracer.bufferedCount()).toBe(0);
  });

  it("flush() is a no-op", async () => {
    const tracer = new Tracer(disabledConfig());
    tracer.end(tracer.startSpan("op"));
    await tracer.flush();
    expect(tracer.bufferedCount()).toBe(0);
  });

  it("exposes enabled=false", () => {
    expect(new Tracer(disabledConfig()).enabled).toBe(false);
    expect(new Tracer(enabledConfig("http://127.0.0.1:1")).enabled).toBe(true);
  });
});

describe("span hierarchy", () => {
  it("child spans share the parent's traceId via parentSpanId", () => {
    const tracer = new Tracer(enabledConfig("http://127.0.0.1:1"));
    const parent = tracer.startSpan("parent");
    // traceId inheritance resolves through the buffered spans list,
    // so the parent must be ended (queued) before the child starts.
    tracer.end(parent);
    const child = tracer.startSpan("child", { parentSpanId: parent.spanId });
    tracer.end(child);
    const grandchild = tracer.startSpan("grandchild", { parentSpanId: child.spanId });

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(grandchild.traceId).toBe(parent.traceId);
    expect(grandchild.parentSpanId).toBe(child.spanId);
    expect(grandchild.spanId).not.toBe(child.spanId);
  });

  it("spans without parents get distinct traceIds", () => {
    const tracer = new Tracer(enabledConfig("http://127.0.0.1:1"));
    const a = tracer.startSpan("a");
    const b = tracer.startSpan("b");
    expect(a.traceId).not.toBe(b.traceId);
  });

  it("an unknown parentSpanId falls back to a fresh traceId", () => {
    const tracer = new Tracer(enabledConfig("http://127.0.0.1:1"));
    const span = tracer.startSpan("orphan", { parentSpanId: "0".repeat(16) });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.parentSpanId).toBe("0".repeat(16));
  });
});

describe("setTracer / getTracer singleton", () => {
  afterEach(() => {
    setTracer(null);
  });

  it("getTracer lazily creates and reuses a singleton", () => {
    setTracer(null);
    const t1 = getTracer();
    const t2 = getTracer();
    expect(t1).toBe(t2);
    expect(t1).toBeInstanceOf(Tracer);
  });

  it("setTracer replaces the global tracer", () => {
    const custom = new Tracer(disabledConfig({ serviceName: "custom" }));
    setTracer(custom);
    expect(getTracer()).toBe(custom);
  });

  it("setTracer(null) resets the singleton so it is re-created", () => {
    const custom = new Tracer(disabledConfig());
    setTracer(custom);
    setTracer(null);
    const fresh = getTracer();
    expect(fresh).not.toBe(custom);
    expect(fresh).toBeInstanceOf(Tracer);
    setTracer(null);
  });
});

describe("flush() OTLP export", () => {
  let server: Server;
  let endpoint: string;
  let requests: Array<{ body: any; headers: Record<string, unknown> }>;

  beforeEach(async () => {
    requests = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        requests.push({ body: JSON.parse(data), headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function findAttr(attrs: any[], key: string): any {
    const entry = attrs.find((a: any) => a.key === key);
    if (!entry) return undefined;
    const v = entry.value;
    return v.stringValue ?? v.doubleValue ?? v.boolValue;
  }

  it("posts a well-formed OTLP/JSON payload to /v1/traces", async () => {
    const tracer = new Tracer(
      enabledConfig(endpoint, { resourceAttributes: { env: "test" } })
    );
    const parent = tracer.startSpan("codepilot.prompt", {
      attributes: { "session.id": "s-1", "turn": 2, "cached": false },
    });
    tracer.end(parent);
    const child = tracer.startSpan("codepilot.tool_call", { parentSpanId: parent.spanId });
    tracer.addEvent(child, "tool_result", { ok: true });
    tracer.end(child);
    const failing = tracer.startSpan("codepilot.llm_call", { parentSpanId: parent.spanId });
    tracer.recordError(failing, new Error("rate limited"));
    tracer.end(failing);

    expect(tracer.bufferedCount()).toBe(3);
    await tracer.flush();
    expect(tracer.bufferedCount()).toBe(0);

    expect(requests).toHaveLength(1);
    const { body, headers } = requests[0];
    expect(headers["content-type"]).toBe("application/json");

    // Top-level OTLP structure.
    expect(body.resourceSpans).toHaveLength(1);
    const rs = body.resourceSpans[0];
    expect(findAttr(rs.resource.attributes, "service.name")).toBe("codepilot-test");
    expect(findAttr(rs.resource.attributes, "env")).toBe("test");
    expect(typeof findAttr(rs.resource.attributes, "host.name")).toBe("string");

    expect(rs.scopeSpans).toHaveLength(1);
    expect(rs.scopeSpans[0].scope.name).toBe("codepilot");
    const spans = rs.scopeSpans[0].spans;
    expect(spans).toHaveLength(3);

    // Parent span details + typed attribute encoding.
    const parentOut = spans.find((s: any) => s.name === "codepilot.prompt")!;
    expect(parentOut.traceId).toBe(parent.traceId);
    expect(parentOut.spanId).toBe(parent.spanId);
    expect(parentOut.parentSpanId).toBeUndefined();
    expect(parentOut.kind).toBe(1);
    expect(parentOut.startTimeUnixNano).toBe(parent.startTimeUnixNano);
    expect(parentOut.endTimeUnixNano).toBe(parent.endTimeUnixNano);
    expect(findAttr(parentOut.attributes, "session.id")).toBe("s-1");
    expect(findAttr(parentOut.attributes, "turn")).toBe(2);
    expect(findAttr(parentOut.attributes, "cached")).toBe(false);
    expect(parentOut.status).toEqual({ code: 0 });

    // Child span links to the parent trace.
    const childOut = spans.find((s: any) => s.name === "codepilot.tool_call")!;
    expect(childOut.traceId).toBe(parent.traceId);
    expect(childOut.parentSpanId).toBe(parent.spanId);
    expect(childOut.events).toHaveLength(1);
    expect(childOut.events[0].name).toBe("tool_result");
    expect(findAttr(childOut.events[0].attributes, "ok")).toBe(true);

    // Error span carries status + exception event.
    const failingOut = spans.find((s: any) => s.name === "codepilot.llm_call")!;
    expect(failingOut.status.code).toBe(2);
    expect(failingOut.status.message).toBe("rate limited");
    const exc = failingOut.events.find((e: any) => e.name === "exception")!;
    expect(findAttr(exc.attributes, "exception.message")).toBe("rate limited");
  });

  it("flush() with nothing buffered sends no request", async () => {
    const tracer = new Tracer(enabledConfig(endpoint));
    await tracer.flush();
    expect(requests).toHaveLength(0);
  });

  it("handles export failure gracefully (server error status)", async () => {
    server.close();
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const tracer = new Tracer(enabledConfig(`http://127.0.0.1:${port}`));
    tracer.end(tracer.startSpan("doomed"));
    await expect(tracer.flush()).resolves.toBeUndefined();
    // Spans are dropped after a failed export (never breaks the session).
    expect(tracer.bufferedCount()).toBe(0);
  });

  it("handles export failure gracefully (connection refused)", async () => {
    // Bind then immediately close to get a guaranteed-unused port.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));

    const tracer = new Tracer(enabledConfig(`http://127.0.0.1:${port}`));
    tracer.end(tracer.startSpan("doomed"));
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(tracer.bufferedCount()).toBe(0);
  });

  it("auto-flushes when the batch reaches maxBatchSize (64)", async () => {
    const tracer = new Tracer(enabledConfig(endpoint));
    for (let i = 0; i < 64; i++) {
      tracer.end(tracer.startSpan(`span-${i}`));
    }
    // end() triggers flush() synchronously (async export in flight).
    expect(tracer.bufferedCount()).toBe(0);
    await tracer.flush(); // no-op; batch already in flight
    // Give the in-flight request a moment to land on the server.
    await new Promise((r) => setTimeout(r, 200));
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const totalSpans = requests.reduce(
      (n, r) => n + r.body.resourceSpans[0].scopeSpans[0].spans.length,
      0
    );
    expect(totalSpans).toBe(64);
  });
});
