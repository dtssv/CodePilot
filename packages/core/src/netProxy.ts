// Cooperative network egress proxy (B3 Part A, step 2).
//
// A tiny dependency-free HTTP/HTTPS forward proxy that enforces a host
// allowlist. It is pointed at by HTTP_PROXY/HTTPS_PROXY env vars injected into
// sandboxed bash commands, so ordinary tools (curl, npm, pip, git-over-https)
// are transparently restricted to the configured hosts.
//
// Scope and limits (deliberate):
//  - Cooperative only: a process that opens a raw socket ignoring the proxy
//    env vars bypasses it. Non-cooperative enforcement (net namespace / OS
//    scoping) is a separate step (see docs/design/B3-landlock-network-proxy.md).
//  - HTTPS via CONNECT is tunneled, NOT terminated: we allow/deny on the
//    requested host:port, then relay bytes. No TLS interception, so payloads
//    stay private and no cert trust surgery is needed.
//  - Host matching is by allowlist globs ("*.github.com"); everything else is
//    refused with a logged 403 / connection refusal.

import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

export interface NetProxyPolicy {
  /** Host globs allowed to be reached. Case-insensitive. Empty = deny all. */
  allow: string[];
  /** Allowed destination ports. Default [80, 443]. */
  allowPorts?: number[];
  /** Record refused hosts (for surfacing to the model). Default true. */
  denyLog?: boolean;
}

/** Compile a host glob ("*.example.com", "example.com") to a matcher. */
function hostMatcher(globs: string[]): (host: string) => boolean {
  const patterns = globs.map((g) => {
    const esc = g
      .trim()
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except *
      .replace(/\*/g, "[^.]*"); // * matches a single label segment
    return new RegExp(`^${esc}$`);
  });
  return (host: string) => {
    const h = host.toLowerCase().replace(/\.$/, "");
    return patterns.some((p) => p.test(h));
  };
}

/** Parse a `host:port` authority; defaults the port when absent. */
export function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } {
  // IPv6 literal in brackets, e.g. [::1]:443
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : defaultPort };
  const idx = authority.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(authority.slice(idx + 1))) {
    return { host: authority.slice(0, idx), port: Number(authority.slice(idx + 1)) };
  }
  return { host: authority, port: defaultPort };
}

export interface RunningNetProxy {
  /** Loopback port the proxy listens on. */
  port: number;
  /** Hosts that were refused (deduplicated, in first-seen order). */
  readonly refusals: readonly string[];
  /** Stop the proxy and release the port. */
  close(): Promise<void>;
}

/**
 * Start the allowlist proxy on 127.0.0.1 with an ephemeral port. Returns once
 * it is listening. Fails the returned promise if it cannot bind.
 */
export function startNetProxy(policy: NetProxyPolicy): Promise<RunningNetProxy> {
  const allowed = hostMatcher(policy.allow ?? []);
  const ports = new Set(policy.allowPorts && policy.allowPorts.length > 0 ? policy.allowPorts : [80, 443]);
  const denyLog = policy.denyLog ?? true;
  const refusals: string[] = [];
  const seen = new Set<string>();
  const refuse = (host: string) => {
    if (!denyLog) return;
    if (seen.has(host)) return;
    seen.add(host);
    refusals.push(host);
  };
  const permit = (host: string, port: number) => allowed(host) && ports.has(port);

  // Plain HTTP: proxy requests arrive with an absolute-form URL.
  const onHttp = (req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("bad proxy request");
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    if (!permit(target.hostname, port)) {
      refuse(target.hostname);
      res.writeHead(403).end(`host not allowed: ${target.hostname}`);
      return;
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };

  const server: Server = createServer(onHttp);

  // HTTPS (and any TLS) via CONNECT: allow/deny then blind-tunnel bytes.
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const { host, port } = parseAuthority(req.url ?? "", 443);
    if (!permit(host, port)) {
      refuse(host);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const kill = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", kill);
    clientSocket.on("error", kill);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({
        port,
        get refusals() {
          return refusals;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
