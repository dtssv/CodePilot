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

  async read(ref: string): Promise<string> {
    const buf = await readFile(this.pathFor(ref));
    return buf.toString("utf-8");
  }

  /** Resolve a path that may be inside the workspace. */
  resolve(p: string): string {
    return resolve(p);
  }
}
