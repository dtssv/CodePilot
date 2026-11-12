// Linux-gated integration test for enforced network egress under bwrap.
//
// When both bwrap and slirp4netns are installed (Linux), a "proxy" network
// policy must physically confine the sandboxed command's egress to the
// loopback allowlist proxy: a direct connection to a non-allowlisted host
// fails even if the command ignores HTTP(S)_PROXY, while the allowlisted proxy
// path succeeds. The whole suite skips on any host missing either binary (every
// non-Linux dev machine and CI without slirp4netns), so it is a no-op there.

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolveSandbox, wrapCommand } from "../src/sandbox.js";
import { startNetProxy, type RunningNetProxy } from "../src/netProxy.js";

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

const bwrap = firstExisting(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]);
const slirp = firstExisting([
  "/usr/bin/slirp4netns",
  "/bin/slirp4netns",
  "/usr/local/bin/slirp4netns",
]);
const enabled = process.platform === "linux" && !!bwrap && !!slirp;

function run(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: 25_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number"
        ? (err as { code: number }).code
        : err
          ? 1
          : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!enabled)("enforced proxy egress (bwrap + slirp4netns)", () => {
  it("blocks a direct non-allowlisted connection and allows the proxy path", { timeout: 35_000 }, async () => {
    // An allowlisted origin server the proxy will permit. We allow only its
    // host, so any OTHER destination must be refused by the proxy, and a RAW
    // socket to any public host must be unroutable (slirp binds outbound to
    // host loopback, so only the gateway→proxy path carries traffic).
    const dir = mkdtempSync(join(tmpdir(), "enf-"));
    let origin: Server | undefined;
    let proxy: RunningNetProxy | undefined;
    try {
      origin = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok-from-origin");
      });
      await new Promise<void>((r) => origin!.listen(0, "127.0.0.1", r));
      const originPort = (origin.address() as { port: number }).port;

      // Allow only the origin host:port through the proxy.
      proxy = await startNetProxy({
        allow: ["127.0.0.1"],
        allowPorts: [originPort],
        denyLog: true,
      });
      const policy = {
        ...resolveSandbox(
          { mode: "workspace-write", network: { mode: "proxy", allow: ["127.0.0.1"], allowPorts: [originPort] } },
          dir,
        ),
        proxyUrl: `http://127.0.0.1:${proxy.port}`,
      };

      // Run both probes in a single bwrap invocation to halve setup overhead.
      // Direct: proxy-ignoring connection to a public host must fail (slirp
      // confines outbound to loopback, so it cannot route).
      // Proxy: allowlisted origin through the injected proxy env must succeed.
      const combined = wrapCommand(
        `curl --noproxy '*' --connect-timeout 3 --max-time 5 -s -o /dev/null -w '%{http_code}' http://93.184.216.34/ ; echo "direct_rc=$?" ; curl --max-time 5 -s http://127.0.0.1:${originPort}/`,
        policy,
      );
      const res = await run(combined.command);
      // Direct connection must fail (non-zero rc or process killed by timeout).
      const blocked = /direct_rc=[1-9]/.test(res.stdout) || res.code !== 0;
      expect(blocked).toBe(true);
      // Allowlisted origin through proxy must return the body.
      expect(res.stdout).toContain("ok-from-origin");
    } finally {
      proxy?.close();
      await new Promise<void>((r) => (origin ? origin.close(() => r()) : r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
