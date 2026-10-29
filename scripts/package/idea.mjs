#!/usr/bin/env node
/**
 * Build the IntelliJ plugin and copy the distribution zip to dist/release/idea/.
 *
 * Build requires JDK 17 (the IntelliJ Platform 2024.1 toolchain). JDK 25 breaks
 * Kotlin 2.0.21's JavaVersion.parse, so we never launch gradle with it. When a
 * compatible JDK is available the plugin is built fresh; otherwise, if a valid
 * distribution zip already exists (from a prior build or CI), we fall back to
 * copying it so dist/release/idea/ is never empty — with a clear warning.
 */

import { existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RELEASE_ROOT, REPO_ROOT, ensureDir, fail, log, run } from "./_util.mjs";

const ideaDir = join(REPO_ROOT, "apps", "idea");
const outDir = join(RELEASE_ROOT, "idea");
const distDir = join(ideaDir, "build", "distributions");

/** Report `major.minor` of a JDK at `home`, or null if it can't be read. */
function javaMajor(home) {
  const bin = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!existsSync(bin)) return null;
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) : null;
}

/**
 * Find a JDK the toolchain accepts. The upgraded matrix (Gradle 9.7.1 wrapper +
 * Kotlin 2.2.0 + intellij-platform 2.19.0 + foojay 1.0.0) builds on JDK 17, 21,
 * or 25. Older Kotlin (2.0/2.1) threw on JDK 25's version string, which is why
 * the whole chain was bumped. Returns an absolute JAVA_HOME or undefined.
 */
function detectCompatibleJavaHome() {
  const acceptable = (major) => major === 17 || major === 21 || major === 25 || major === 11;
  // macOS: enumerate via java_home. Prefer 17 (JetBrains baseline), then 21/25.
  if (process.platform === "darwin") {
    for (const ver of ["17", "21", "25", "11"]) {
      const r = spawnSync("/usr/libexec/java_home", ["-v", ver], { encoding: "utf8" });
      const home = r.status === 0 ? r.stdout.trim() : "";
      if (home && acceptable(javaMajor(home) ?? 0)) return home;
    }
  }
  // JAVA_HOME, only if it's an acceptable version.
  if (process.env.JAVA_HOME) {
    const home = process.env.JAVA_HOME;
    if (existsSync(join(home, "bin")) && acceptable(javaMajor(home) ?? 0)) return home;
  }
  return undefined;
}

/** Copy every distribution zip to the release dir. Returns the count copied. */
function collectZips() {
  if (!existsSync(distDir)) return 0;
  const zips = readdirSync(distDir).filter((f) => f.endsWith(".zip"));
  for (const z of zips) {
    const dest = join(outDir, z);
    copyFileSync(join(distDir, z), dest);
    log(`idea plugin → ${dest}`);
  }
  return zips.length;
}

async function main() {
  ensureDir(outDir);
  const gradlew =
    process.platform === "win32" ? join(ideaDir, "gradlew.bat") : join(ideaDir, "gradlew");
  if (!existsSync(gradlew)) fail(`missing ${gradlew}`);

  const javaHome = detectCompatibleJavaHome();
  const hasExistingZip =
    existsSync(distDir) && readdirSync(distDir).some((f) => f.endsWith(".zip"));

  if (!javaHome) {
    // No JDK 17/21 to launch gradle with. If a valid plugin zip already exists,
    // ship it rather than leaving the release empty; otherwise fail with guidance.
    if (hasExistingZip) {
      log(
        "warning: no JDK 17/21 found — reusing the existing IDEA distribution zip " +
          "without rebuilding. Install Temurin 17 to produce a fresh build " +
          "(macOS: brew install --cask temurin@17).",
      );
      const n = collectZips();
      log(`IDEA release (reused existing build) → ${outDir} (${n} zip)`);
      return;
    }
    fail(
      "No JDK 17/21 found and no prebuilt IDEA zip to reuse. Install Temurin 17 " +
        "(macOS: brew install --cask temurin@17) then re-run pnpm package:idea.",
    );
  }

  log(`using JDK ${javaHome}`);
  const args = ["buildPlugin", "--no-daemon", `-Dorg.gradle.java.home=${javaHome}`];
  const code = run(gradlew, args, { cwd: ideaDir, allowFail: true });
  if (code !== 0) {
    if (hasExistingZip) {
      log(`warning: buildPlugin failed (exit ${code}); reusing the existing IDEA zip.`);
      const n = collectZips();
      log(`IDEA release (reused existing build) → ${outDir} (${n} zip)`);
      return;
    }
    fail(
      `IDEA buildPlugin failed (exit ${code}). Need JDK 17, 21, or 25. ` +
        "Set JAVA_HOME to a supported JDK or pass -Dorg.gradle.java.home=…",
    );
  }

  const n = collectZips();
  if (n === 0) fail("buildPlugin produced no .zip");
  log(`IDEA release → ${outDir} (${n} zip)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
