import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  mintRemotePairing,
  redeemRemotePairing,
  revokeAllRemoteControl,
} from "../src/remoteControl.js";

describe("remoteControl one-time pairing", () => {
  afterEach(async () => {
    await revokeAllRemoteControl();
  });

  it("mints and redeems once only", async () => {
    const minted = await mintRemotePairing({
      serveUrl: "http://127.0.0.1:18765",
      cwd: mkdtempSync(join(tmpdir(), "rc-")),
    });
    expect(minted.code).toMatch(/^[a-f0-9]+$/);
    expect(minted.qrPayload).toContain("code=");
    expect(minted.qrPayload).toContain("s=");

    const url = new URL(minted.url);
    const code = url.searchParams.get("code")!;
    const secret = url.searchParams.get("s")!;
    const first = await redeemRemotePairing(code, secret);
    expect(first.grant.token.length).toBeGreaterThan(20);
    expect(first.grant.caps).toContain("prompt");

    await expect(redeemRemotePairing(code, secret)).rejects.toThrow(/already-used|Invalid/i);
    void homedir;
  });

  it("authorizes multiple workspaces (active first, deduped)", async () => {
    const a = mkdtempSync(join(tmpdir(), "rc-a-"));
    const b = mkdtempSync(join(tmpdir(), "rc-b-"));
    const minted = await mintRemotePairing({
      serveUrl: "http://127.0.0.1:18765",
      cwd: a,
      // Include a duplicate of the active cwd and an extra; both are normalized.
      cwds: [a, b],
    });
    const url = new URL(minted.url);
    const redeemed = await redeemRemotePairing(
      url.searchParams.get("code")!,
      url.searchParams.get("s")!,
    );
    expect(redeemed.cwd).toBe(a);
    expect(redeemed.cwds).toEqual([a, b]);
    expect(redeemed.grant.cwds).toEqual([a, b]);
  });

  it("defaults cwds to the single bound workspace", async () => {
    const a = mkdtempSync(join(tmpdir(), "rc-single-"));
    const minted = await mintRemotePairing({ serveUrl: "http://127.0.0.1:18765", cwd: a });
    const url = new URL(minted.url);
    const redeemed = await redeemRemotePairing(
      url.searchParams.get("code")!,
      url.searchParams.get("s")!,
    );
    expect(redeemed.cwds).toEqual([a]);
  });
});
