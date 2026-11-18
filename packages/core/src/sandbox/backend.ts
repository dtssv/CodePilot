// OS-level sandboxing for tool execution. Two layers driven by one
// SandboxConfig: process layer (bash via sandbox-exec/bwrap/WSL) and tool
// layer (assertPathAllowed validates paths before I/O). Pure Node;
// dependency-free; never throws from detection.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { SandboxBackend, SandboxUnavailable } from "./types.js";

/** Platform-specific guidance for restoring a working OS sandbox backend. */
export function sandboxUnavailableHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "linux":
      return (
        "No OS sandbox backend found. Install bubblewrap (e.g. `apt install bubblewrap`), " +
        "or a Landlock launcher, or set sandbox.mode=\"off\" / sandbox.fallback=\"allow-unsandboxed\"."
      );
    case "win32":
      return (
        "No OS sandbox backend found. CodePilot sandboxes Windows through WSL2 with bubblewrap: " +
        "install WSL2 (`wsl --install`) and bubblewrap inside the default distro " +
        "(`apt install bubblewrap`), or set sandbox.mode=\"off\" / sandbox.fallback=\"allow-unsandboxed\"."
      );
    case "darwin":
      return (
        "sandbox-exec (Seatbelt) was not found at /usr/bin/sandbox-exec. " +
        "Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
      );
    default:
      return (
        `No OS sandbox backend is available on this platform (${platform}). ` +
        "Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
      );
  }
}

/** Build the structured unavailable descriptor for the current platform. */
export function buildSandboxUnavailable(platform: NodeJS.Platform = process.platform): SandboxUnavailable {
  return { backend: "none", platform, hint: sandboxUnavailableHint(platform) };
}

let cachedBackend: SandboxBackend | null = null;

/** True when WSL is installed and has bubblewrap inside the default distro. */
function probeWslBwrap(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("wsl.exe", ["-e", "bwrap", "--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

let cachedLandlock: string | null | undefined = undefined;

/** Resolve a Landlock launcher binary, or null when none is installed.
 * Landlock is a filesystem-only jail (no network namespace); used as a
 * write-scoping fallback for hosts where user namespaces are disabled. */
export function landlockLauncherPath(): string | null {
  if (cachedLandlock !== undefined) return cachedLandlock;
  if (process.platform !== "linux") {
    cachedLandlock = null;
    return cachedLandlock;
  }
  for (const p of [
    "/usr/bin/codepilot-landlock",
    "/usr/local/bin/codepilot-landlock",
    "/usr/bin/landlock-sandboxer",
    "/usr/local/bin/landlock-sandboxer",
  ]) {
    if (existsSync(p)) {
      cachedLandlock = p;
      return cachedLandlock;
    }
  }
  cachedLandlock = null;
  return cachedLandlock;
}

/** Probe the host for an available sandbox backend. Cached per process.
 * Linux: bwrap first, then Landlock fallback. Windows: WSL2 + bwrap.
 * No backend → "none" (fail-closed). */
export function detectSandboxBackend(): SandboxBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    cachedBackend = "seatbelt";
  } else if (
    process.platform === "linux" &&
    (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap") || existsSync("/usr/local/bin/bwrap"))
  ) {
    cachedBackend = "bwrap";
  } else if (process.platform === "linux" && landlockLauncherPath()) {
    cachedBackend = "landlock";
  } else if (probeWslBwrap()) {
    cachedBackend = "wsl-bwrap";
  } else {
    cachedBackend = "none";
  }
  return cachedBackend;
}

/** Test hook: reset the cached probe. */
export function resetSandboxBackendCache(): void {
  cachedBackend = null;
  cachedSlirp = null;
  cachedLandlock = undefined;
}

let cachedSlirp: string | null | undefined = undefined;

/** Resolve the slirp4netns binary path, or null when it is not installed.
 * slirp4netns gives an `--unshare-net` namespace a userspace network stack so
 * egress can be forced through the loopback allowlist proxy (enforced, not
 * cooperative). Probed the same way as bwrap (fixed install paths) and cached
 * per process. */
export function slirp4netnsPath(): string | null {
  if (cachedSlirp !== undefined) return cachedSlirp;
  if (process.platform !== "linux") {
    cachedSlirp = null;
    return cachedSlirp;
  }
  for (const p of ["/usr/bin/slirp4netns", "/bin/slirp4netns", "/usr/local/bin/slirp4netns"]) {
    if (existsSync(p)) {
      cachedSlirp = p;
      return cachedSlirp;
    }
  }
  cachedSlirp = null;
  return cachedSlirp;
}
