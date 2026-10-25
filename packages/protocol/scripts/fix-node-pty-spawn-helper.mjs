/**
 * node-pty@1.1.0 publishes macOS spawn-helper without +x; pnpm keeps that mode
 * and every pty.spawn() fails with "posix_spawnp failed". Restore execute bit.
 */
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "darwin") process.exit(0);

try {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const rel of [
    `prebuilds/darwin-${process.arch}/spawn-helper`,
    "prebuilds/darwin-arm64/spawn-helper",
    "prebuilds/darwin-x64/spawn-helper",
    "build/Release/spawn-helper",
    "build/Debug/spawn-helper",
  ]) {
    const helper = join(root, rel);
    if (!existsSync(helper)) continue;
    try {
      chmodSync(helper, 0o755);
    } catch {
      /* ignore */
    }
  }
} catch {
  /* node-pty not installed yet */
}
