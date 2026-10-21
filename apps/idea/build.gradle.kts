plugins {
    // IntelliJ Platform Gradle Plugin 2.x — see https://plugins.jetbrains.com/plugin/26102-intellij-platform-gradle-plugin
    id("org.jetbrains.intellij.platform") version "2.1.0"
    kotlin("jvm") version "2.1.0"
}

// ----- Project identity -----
group = "com.codepilot"
version = "0.1.0"

// ----- Repositories are declared in settings.gradle.kts (dependencyResolutionManagement). -----

// ----- Java / Kotlin toolchain -----
java {
    toolchain {
        // IntelliJ Platform 2024.1 (build 233.*) is built on JDK 17.
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

kotlin {
    jvmToolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    intellijPlatform {
        // Pull a specific IntelliJ IDEA Community Edition build for the plugin classpath.
        // useInstaller=false uses the Maven-published `com.jetbrains.intellij.idea:ideaIC:...` artifact
        // (instead of the JetBrains-downloaded "idea:ideaIC" installer coordinate).
        // Note: we don't request specific bundled plugins — the IDEA distribution itself ships
        // the necessary JBR / Java / Terminal modules on the classpath when unpacked.
        intellijIdeaCommunity("2024.1.7", useInstaller = false)

        // Required by `instrumentCode` task in IntelliJ Platform Gradle Plugin 2.x.
        instrumentationTools()
    }

    // JSON-RPC payloads travel as NDJSON; use Gson (already on the IntelliJ Platform classpath via Android plugin
    // transitively). Declaring it explicitly avoids surprises when the platform classpath changes.
    implementation("com.google.code.gson:gson:2.11.0")

    // Kotlin coroutines — IDEA 2024.1 already ships stdlib but not coroutines.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:1.8.1")
    // `Dispatchers.Swing` (used by ChatPanel) lives in this module.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.8.1")

    // ----- Test dependencies -----
    // JUnit 5 (Jupiter) — test engine + assertions.
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    // MockK — mocking framework for Kotlin (used for spying the client's NDJSON sink).
    testImplementation("io.mockk:mockk-jvm:1.13.12")
    // Coroutines test utilities (runTest, TestDispatcher) — available for future async tests.
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}

intellijPlatform {
    buildSearchableOptions.set(false)
    pluginConfiguration {
        id = "com.codepilot.idea"
        name = "CodePilot"
        version = project.version.toString()
        description = "CodePilot — headless coding agent client. Spawns `codepilot serve` over NDJSON JSON-RPC."
        changeNotes = "Chat tool window runs the shared CodePilot UI (JCEF), with a Swing fallback."

        // Since/until — match IntelliJ Platform 2.x expectations (YYMM build numbers).
        ideaVersion {
            sinceBuild = "233"
            untilBuild = "251.*"
        }
    }

    // Sandbox used by `runIde` for manual testing.
    sandboxContainer.set(project.layout.buildDirectory.dir("idea-sandbox"))
}

// The chat tool window runs the shared web UI: bundle apps/web's single-file
// embed build (`pnpm --filter @codepilot/web build`) as /webview/index.html.
// On CI / clean checkouts that file may be absent — write a stub so unit tests
// and compile still run; `buildPlugin` packaging should run web build first.
val webviewResources = layout.buildDirectory.dir("generated/webview")
val copyWebview by tasks.registering {
    val srcPath = rootProject.projectDir.resolve("../web/dist-embed/index.html").normalize()
    val destDir = webviewResources.map { it.dir("webview") }
    outputs.dir(destDir)
    // Do not declare optional inputs.file(...) — missing paths break configuration
    // on some Gradle versions. Stamp the source path as a property instead.
    inputs.property("webviewSrc", srcPath.absolutePath)
    inputs.property("webviewSrcExists", srcPath.isFile)
    doLast {
        val out = destDir.get().asFile
        out.mkdirs()
        val target = out.resolve("index.html")
        if (srcPath.isFile) {
            srcPath.copyTo(target, overwrite = true)
        } else {
            target.writeText(
                "<!doctype html><html><body>CodePilot webview stub — run " +
                    "<code>pnpm --filter @codepilot/web build</code> before packaging.</body></html>\n",
            )
        }
    }
}

// Bundled CodePilot CLI so the plugin works without a system install.
val engineCliResources = layout.buildDirectory.dir("generated/engine")
val bundleEngineCli by tasks.registering(Exec::class) {
    val outFile = engineCliResources.map { it.file("codepilot-cli.cjs").asFile }
    outputs.file(outFile)
    workingDir = rootProject.projectDir.resolve("../..")
    commandLine(
        "node",
        rootProject.projectDir.resolve("../../scripts/package/bundle-plugin-cli.mjs").absolutePath,
        outFile.get().absolutePath,
    )
    // Best-effort: if Node/protocol build is unavailable, skip (PATH fallback).
    isIgnoreExitValue = true
}
sourceSets.main {
    resources.srcDir(webviewResources)
    resources.srcDir(engineCliResources)
}
tasks.processResources {
    dependsOn(copyWebview)
    dependsOn(bundleEngineCli)
}

// Pure unit tests (no IDE fixture) — protocol logic, serialization, settings roundtrip.
// Anything requiring a Project/Editor must use the IDE fixture framework and live elsewhere.
tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // MockK / Gson reflection on JDK 17+
    jvmArgs(
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.io=ALL-UNNAMED",
    )
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showCauses = true
        showStackTraces = true
        showStandardStreams = true
    }
}