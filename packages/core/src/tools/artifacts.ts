// Artifact store: spill large tool results to disk under
// `~/.codepilot/projects/<hash>/artifacts/` so the model's context stays
// small. The store returns a reference id that can be passed back to
// read_artifact.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export class ArtifactStore {
  constructor(public readonly rootDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  /** Normalise a ref ("art_<hash>" or a bare hash) to the bare hash, or null
   * when it is not a valid artifact reference. */
  static hashOf(ref: string): string | null {
    const hash = ref.startsWith("art_") ? ref.slice(4) : ref;
    return /^[a-f0-9]{16,128}$/.test(hash) ? hash : null;
  }

  private pathFor(ref: string): string {
 // Accept either a raw hash or a "art_<hash>" id; normalise to bare hash.
    const hash = ArtifactStore.hashOf(ref);
    if (!hash) {
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
 * Serialise a JSON value, write it, and return the artifact reference and byte
 * count. Pretty-printed so the artifact file is diff-friendly on inspection.
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

 /** Byte size of the stored artifact, or null when absent/invalid. Fail-soft:
  * used to record the authoritative full-payload size in a content_replacement
  * audit event without re-reading the content. */
  async size(ref: string): Promise<number | null> {
    try {
      const st = await stat(this.pathFor(ref));
      return st.size;
    } catch {
      return null;
    }
  }

 /** All artifact refs ("art_<hash>") currently stored. Used by GC to diff the
  * on-disk set against the set still referenced by live sessions. Fail-soft:
  * returns [] when the store dir is missing/unreadable. */
  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.rootDir);
      const out: string[] = [];
      for (const n of names) {
        if (!n.endsWith(".txt")) continue; // skip .meta sidecars and others
        const hash = n.slice(0, -4);
        if (/^[a-f0-9]{16,128}$/.test(hash)) out.push(`art_${hash}`);
      }
      return out;
    } catch {
      return [];
    }
  }

 /** Delete an artifact (and its .meta sidecar). Returns the bytes reclaimed
  * (0 when the artifact was already gone). Fail-soft. Used by GC only — never
  * delete an artifact still referenced by a live session. */
  async remove(ref: string): Promise<number> {
    let reclaimed = 0;
    try {
      const p = this.pathFor(ref);
      try {
        const st = await stat(p);
        reclaimed = st.size;
      } catch {
        /* already gone */
      }
      await unlink(p).catch(() => undefined);
      await unlink(p + ".meta").catch(() => undefined);
    } catch {
      /* invalid ref — nothing to do */
    }
    return reclaimed;
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
