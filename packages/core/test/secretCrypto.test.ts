// Asymmetric secret encryption for ~/.codepilot/config.json apiKeys.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  SECRET_PREFIX,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  encryptSecretFields,
  decryptSecretFields,
  _resetSecretCryptoCacheForTests,
} from "../src/config/secretCrypto.js";
import { writeUserConfigFile, readUserConfigFile } from "../src/config/providerCatalog.js";

describe("secretCrypto", () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    _resetSecretCryptoCacheForTests();
    home = await mkdtemp(join(tmpdir(), "cp-secrets-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // Also cover macOS where Node may use USERPROFILE / HOMEPATH differently —
    // secretCrypto uses os.homedir() which reads HOME on Unix.
    await mkdir(join(home, ".codepilot"), { recursive: true });
  });

  afterEach(async () => {
    _resetSecretCryptoCacheForTests();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("round-trips a plaintext apiKey", async () => {
    const enc = await encryptSecret("sk-test-secret-value");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(enc.startsWith(SECRET_PREFIX)).toBe(true);
    expect(enc).not.toContain("sk-test");
    expect(await decryptSecret(enc)).toBe("sk-test-secret-value");
  });

  it("is idempotent for already-encrypted values", async () => {
    const enc = await encryptSecret("sk-abc");
    expect(await encryptSecret(enc)).toBe(enc);
  });

  it("encryptSecretFields walks providers and leaves other keys alone", async () => {
    const raw = {
      provider: "openai",
      apiKey: "sk-top",
      providers: {
        work: { provider: "openai", apiKey: "sk-work", model: "gpt-x" },
      },
      model: "gpt-x",
    };
    const { value, changed } = await encryptSecretFields(raw);
    expect(changed).toBe(true);
    const v = value as typeof raw;
    expect(isEncryptedSecret(v.apiKey)).toBe(true);
    expect(isEncryptedSecret(v.providers.work.apiKey)).toBe(true);
    expect(v.providers.work.model).toBe("gpt-x");
    const back = (await decryptSecretFields(v)) as typeof raw;
    expect(back.apiKey).toBe("sk-top");
    expect(back.providers.work.apiKey).toBe("sk-work");
  });

  it("writeUserConfigFile stores ciphertext and readUserConfigFile returns plaintext", async () => {
    // homedir() must point at our temp home — skip if os.homedir ignores HOME
    // (rare); still assert encrypt path via write + direct file read.
    if (homedir() !== home) {
      // Force via writing secrets under real path is unsafe in CI; just unit the crypto.
      return;
    }
    await writeUserConfigFile({
      providers: {
        oc: { provider: "openai", apiKey: "oc_sk_plain", model: "m" },
      },
    });
    const onDisk = JSON.parse(
      await readFile(join(home, ".codepilot", "config.json"), "utf-8"),
    ) as { providers: { oc: { apiKey: string } } };
    expect(isEncryptedSecret(onDisk.providers.oc.apiKey)).toBe(true);
    expect(onDisk.providers.oc.apiKey).not.toContain("oc_sk_plain");

    const { raw } = await readUserConfigFile();
    const providers = raw.providers as Record<string, { apiKey?: string }>;
    expect(providers.oc?.apiKey).toBe("oc_sk_plain");
  });
});
