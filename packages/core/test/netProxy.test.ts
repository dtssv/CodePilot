import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, request as httpRequest } from "node:http";
import { startNetProxy, parseAuthority, type RunningNetProxy } from "../src/netProxy.js";
import { resolveSandbox, wrapCommand } from "../src/sandbox.js";

describe("parseAuthority", () => {
  it("splits host:port and defaults the port", () => {
    expect(parseAuthority("example.com:443", 443)).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("example.com", 443)).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("example.com", 80)).toEqual({ host: "example.com", port: 80 });
  });

  it("handles IPv6 literals", () => {
    expect(parseAuthority("[::1]:8443", 443)).toEqual({ host: "::1", port: 8443 });
    expect(parseAuthority("[::1]", 443)).toEqual({ host: "::1", port: 443 });
  });
});

describe("resolveSandbox network normalization", () => {
  const cwd = process.cwd();

  it("maps boolean true/false and undefined to full/off/full", () => {
    expect(resolveSandbox({ network: true }, cwd).networkPolicy.mode).toBe("full");
    expect(resolveSandbox({ network: false }, cwd).networkPolicy.mode).toBe("off");
    expect(resolveSandbox(undefined, cwd).networkPolicy.mode).toBe("full");
    // Legacy `network` boolean field stays in sync (false only for "off").
    expect(resolveSandbox({ network: false }, cwd).network).toBe(false);
    expect(resolveSandbox({ network: true }, cwd).network).toBe(true);
  });

  it("carries the allowlist and defaults ports for proxy mode", () => {
    const s = resolveSandbox(
      { network: { mode: "proxy", allow: ["*.npmjs.org"] } },
      cwd,
    );
    expect(s.networkPolicy.mode).toBe("proxy");
    expect(s.networkPolicy.allow).toEqual(["*.npmjs.org"]);
    expect(s.networkPolicy.allowPorts).toEqual([80, 443]);
    // proxy mode still counts as network-enabled (no --unshare-net).
    expect(s.network).toBe(true);
  });
});

describe("wrapCommand proxy env injection", () => {
  const cwd = process.cwd();

  it("injects HTTP(S)_PROXY exports when a proxyUrl is set", () => {
    const base = resolveSandbox({ mode: "off", network: { mode: "proxy", allow: ["x"] } }, cwd);
    // mode "off" short-circuits; use workspace-write so wrapping runs. But we
    // only assert the env prefix, which is independent of the OS backend.
    const policy = {
      ...resolveSandbox({ network: { mode: "proxy", allow: ["x"] } }, cwd),
      proxyUrl: "http://127.0.0.1:12345",
    };
    const w = wrapCommand("curl https://x/", policy);
    // The inner command may be re-quoted by the OS backend (sandbox-exec /
    // bwrap), so assert on the variable names + proxy URL, not exact quoting.
    expect(w.command).toContain("HTTP_PROXY=");
    expect(w.command).toContain("HTTPS_PROXY=");
    expect(w.command).toContain("127.0.0.1:12345");
    expect(w.command).toContain("NO_PROXY=");
    void base;
  });

  it("does not inject proxy env when policy is not proxy mode", () => {
    const policy = resolveSandbox({ network: true }, cwd);
    const w = wrapCommand("echo hi", policy);
    expect(w.command).not.toContain("HTTP_PROXY");
  });
});

describe("startNetProxy (end-to-end over loopback)", () => {
  let proxy: RunningNetProxy | null = null;
  let upstream: Server | null = null;

  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
    upstream = null;
  });

  function startUpstream(): Promise<number> {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-upstream");
    });
    return new Promise((resolve) => {
      upstream!.listen(0, "127.0.0.1", () => {
        const addr = upstream!.address();
        resolve(addr && typeof addr === "object" ? addr.port : 0);
      });
    });
  }

  /** Make a plain-HTTP request *through* the proxy to host:port/path. */
  function viaProxy(
    proxyPort: number,
    host: string,
    port: number,
    path: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          // Absolute-form request URI = proxy request.
          path: `http://${host}:${port}${path}`,
          headers: { host: `${host}:${port}` },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("forwards allowed hosts and refuses the rest", async () => {
    const upstreamPort = await startUpstream();
    // Allow 127.0.0.1 on the upstream's port; deny everything else.
    proxy = await startNetProxy({ allow: ["127.0.0.1"], allowPorts: [upstreamPort] });

    const ok = await viaProxy(proxy.port, "127.0.0.1", upstreamPort, "/");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("hello-upstream");

    const denied = await viaProxy(proxy.port, "blocked.example", upstreamPort, "/");
    expect(denied.status).toBe(403);
    // Refusal is recorded for surfacing to the model.
    expect(proxy.refusals).toContain("blocked.example");
  });

  it("refuses an allowed host on a non-allowed port", async () => {
    const upstreamPort = await startUpstream();
    proxy = await startNetProxy({ allow: ["127.0.0.1"], allowPorts: [1] });
    const denied = await viaProxy(proxy.port, "127.0.0.1", upstreamPort, "/");
    expect(denied.status).toBe(403);
  });
});
