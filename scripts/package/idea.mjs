#!/usr/bin/env node
/**
 * Build the IntelliJ plugin and copy the distribution zip to dist/release/idea/.
 */

import { existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RELEASE_ROOT, REPO_ROOT, ensureDir, fail, log, run } from "./_util.mjs";

const ideaDir = join(REPO_ROOT, "apps", "idea");
const outDir = join(RELEASE_ROOT, "idea");
const distDir = join(ideaDir, "build", "distributions");

/** Prefer JDK 17 (IDEA 2024.1 toolchain). Avoid bleeding-edge JDKs that break Gradle. */
function detectJavaHome() {
  if (process.platform === "darwin") {
    for (const ver of ["17", "21", "11"]) {
      const r = spawnSync("/usr/libexec/java_home", ["-v", ver], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim) return r.stdout.trim;
    }
  }
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, "bin", "java"))) {
    return process.env.JAVA_HOME;
  }
  return undefined;
}

async function main() {
  ensureDir(outDir);
  const gradlew =
    process.platform === "win32" ? join(ideaDir, "gradlew.bat") : join(ideaDir, "gradlew");
  if (!existsSync(gradlew)) fail(`missing ${gradlew}`);

  const javaHome = detectJavaHome;
  const args = ["buildPlugin", "--no-daemon"];
  if (javaHome) {
    args.push(`-Dorg.gradle.java.home=${javaHome}`);
    log(`using JDK ${javaHome}`);
  } else {
    log("warning: no JDK detected; relying on gradle.properties / PATH");
  }

  if (!javaHome) {
    fail(
      "No JDK 17/21 found. Install Temurin 17 (macOS: brew install --cask temurin@17) then re-run pnpm package:idea.",
    );
  }
  const code = run(gradlew, args, { cwd: ideaDir, allowFail: true });
  if (code !== 0) {
    fail(
      `IDEA buildPlugin failed (exit ${code}). Need JDK 17 (not 25). Set JAVA_HOME or pass -Dorg.gradle.java.home=…`,
    );
  }

  if (!existsSync(distDir)) fail(`no distributions at ${distDir}`);
  const zips = readdirSync(distDir).filter((f) => f.endsWith(".zip"));
  if (zips.length === 0) fail("buildPlugin produced no .zip");
  for (const z of zips) {
    const dest = join(outDir, z);
    copyFileSync(join(distDir, z), dest);
    log(`idea plugin → ${dest}`);
  }
  log(`IDEA release → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
