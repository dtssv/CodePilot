// Artifact store: spill large tool results to disk under .codepilot/artifacts/
// so the model's context stays small. The store returns a reference id that
// can be passed back to read_artifact.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export class ArtifactStore {
  constructor(public readonly rootDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  private pathFor(ref: string): string {
    // Accept either a raw hash or a "art_<hash>" id; normalise to bare hash.
    const hash = ref.startsWith("art_") ? ref.slice(4) : ref;
    if (!/^[a-f0-9]{16,128}$/.test(hash)) {
      throw new Error(`Invalid artifact reference: ${ref}`);
    }
    return join(this.rootDir, `${hash}.txt`);
  }

  async write(content: string | Uint8Array, hint?: string): Promise<string> {
    await this.init();
    const buf =
      typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const hash = createHash("sha256").update(buf).digest("hex");
    await writeFile(this.pathFor(hash), buf);
    // Store metadata sidecar (best-effort).
    if (hint) {
      try {
        await writeFile(this.pathFor(hash) + ".meta", JSON.stringify({ hint }), "utf-8");
      } catch {
        /* ignore */
      }
    }
    return `art_${hash}`;
  }

  /**
   * Convenience: serialise a JSON value, write it, and return both the
   * artifact reference and the byte count. Used by the checkpoint writer
   * to stash large per-round debug payloads without growing the
   * transcript. The JSON is pretty-printed so the artifact file is
   * diff-friendly when humans inspect it later.
   */
  async writeJson(value: unknown, hint?: string): Promise<{ ref: string; bytes: number }> {
    const text = JSON.stringify(value, null, 2);
    const ref = await this.write(text, hint);
    return { ref, bytes: Buffer.byteLength(text, "utf-8") };
  }

  async read(ref: string): Promise<string> {
    const buf = await readFile(this.pathFor(ref));
    return buf.toString("utf-8");
  }

  /** Read and JSON-parse an artifact. Throws if parsing fails. */
  async readJson<T = unknown>(ref: string): Promise<T> {
    const text = await this.read(ref);
    return JSON.parse(text) as T;
  }

  /** Resolve a path that may be inside the workspace. */
  resolve(p: string): string {
    return resolve(p);
  }
}
