/**
 * Local asymmetric encryption for secrets persisted in ~/.codepilot/config.json.
 *
 * A machine-local RSA-2048 keypair lives under `~/.codepilot/secrets/`
 * (private key mode 0600). Values are stored as `cpenc:v1:<base64>` so the
 * JSON file is not usable on another machine without the private key.
 *
 * In-memory config always holds plaintext after load; only the on-disk form
 * is ciphertext. UI RPCs continue to redact keys (hasApiKey / apiKeyHint).
 */

import { generateKeyPairSync, privateDecrypt, publicEncrypt, constants } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SECRET_PREFIX = "cpenc:v1:";

const SECRETS_DIR = (): string => join(homedir(), ".codepilot", "secrets");
const PRIVATE_PATH = (): string => join(SECRETS_DIR(), "private.pem");
const PUBLIC_PATH = (): string => join(SECRETS_DIR(), "public.pem");

let cachedPrivate: string | undefined;
let cachedPublic: string | undefined;

export function isEncryptedSecret(value: string): boolean {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

async function ensureKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  if (cachedPrivate && cachedPublic) {
    return { privateKey: cachedPrivate, publicKey: cachedPublic };
  }
  const privPath = PRIVATE_PATH();
  const pubPath = PUBLIC_PATH();
  try {
    await access(privPath);
    await access(pubPath);
    const privateKey = await readFile(privPath, "utf-8");
    const publicKey = await readFile(pubPath, "utf-8");
    cachedPrivate = privateKey;
    cachedPublic = publicKey;
    return { privateKey, publicKey };
  } catch {
    /* generate */
  }
  await mkdir(SECRETS_DIR(), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await writeFile(privPath, privateKey, { encoding: "utf-8", mode: 0o600 });
  await writeFile(pubPath, publicKey, { encoding: "utf-8", mode: 0o600 });
  try {
    await chmod(privPath, 0o600);
    await chmod(pubPath, 0o600);
    await chmod(SECRETS_DIR(), 0o700);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
  cachedPrivate = privateKey;
  cachedPublic = publicKey;
  return { privateKey, publicKey };
}

/** Encrypt a plaintext secret. Idempotent for already-encrypted values. */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext || isEncryptedSecret(plaintext)) return plaintext;
  const { publicKey } = await ensureKeypair();
  const buf = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(plaintext, "utf-8"),
  );
  return SECRET_PREFIX + buf.toString("base64");
}

/** Decrypt a secret. Plaintext (legacy) values pass through unchanged. */
export async function decryptSecret(value: string): Promise<string> {
  if (!value || !isEncryptedSecret(value)) return value;
  const { privateKey } = await ensureKeypair();
  const b64 = value.slice(SECRET_PREFIX.length);
  const buf = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(b64, "base64"),
  );
  return buf.toString("utf-8");
}

/** Keys whose string values are treated as secrets in config JSON. */
const SECRET_FIELD_NAMES = new Set(["apiKey", "api_key", "token", "accessToken", "clientSecret"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Walk a config-shaped object and encrypt every secret field that is still
 * plaintext. Returns whether anything changed (for migration writes).
 */
export async function encryptSecretFields(
  value: unknown,
): Promise<{ value: unknown; changed: boolean }> {
  let changed = false;
  const walk = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) out.push(await walk(item));
      return out;
    }
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_FIELD_NAMES.has(k) && typeof v === "string" && v.length > 0) {
        if (!isEncryptedSecret(v)) {
          out[k] = await encryptSecret(v);
          changed = true;
        } else {
          out[k] = v;
        }
      } else if (isPlainObject(v) || Array.isArray(v)) {
        out[k] = await walk(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  const next = await walk(value);
  return { value: next, changed };
}

/** Walk a config-shaped object and decrypt every encrypted secret field. */
export async function decryptSecretFields(value: unknown): Promise<unknown> {
  const walk = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) out.push(await walk(item));
      return out;
    }
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_FIELD_NAMES.has(k) && typeof v === "string" && v.length > 0) {
        if (isEncryptedSecret(v)) {
          try {
            out[k] = await decryptSecret(v);
          } catch (err) {
            // Never return ciphertext as a usable credential (would 401 as Bearer).
            throw new Error(
              `Failed to decrypt config field "${k}" — re-enter the API key in Settings` +
                (err instanceof Error ? ` (${err.message})` : ""),
            );
          }
        } else {
          out[k] = v;
        }
      } else if (isPlainObject(v) || Array.isArray(v)) {
        out[k] = await walk(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return walk(value);
}

/** Test-only: drop in-memory key cache. */
export function _resetSecretCryptoCacheForTests(): void {
  cachedPrivate = undefined;
  cachedPublic = undefined;
}
