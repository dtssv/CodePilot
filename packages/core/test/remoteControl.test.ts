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
});
