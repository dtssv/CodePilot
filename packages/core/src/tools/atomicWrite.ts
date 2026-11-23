/**
 * Crash/ENOSPC-safe overwrite: write to a same-directory temp file, fsync,
 * then rename into place. Append is not covered — callers
 * keep using `writeFile` with `flag: "a"`.
 *
 * Same-dir temp so rename stays on one filesystem. On Windows, replace an
 * existing destination by unlinking first when rename fails with EEXIST/EPERM.
 */

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const fh = await open(tmp, "wx", 0o600);
  try {
    if (typeof data === "string") {
      await fh.writeFile(data, encoding);
    } else {
      await fh.writeFile(data);
    }
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EEXIST" || code === "EACCES")) {
      await unlink(path).catch(() => undefined);
      try {
        await rename(tmp, path);
        return;
      } catch (err2) {
        await unlink(tmp).catch(() => undefined);
        throw err2;
      }
    }
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
