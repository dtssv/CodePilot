plugins {
    // IntelliJ Platform Gradle Plugin 2.x — see https://plugins.jetbrains.com/plugin/26102-intellij-platform-gradle-plugin
    id("org.jetbrains.intellij.platform") version "2.1.0"
    kotlin("jvm") version "2.0.21"
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
}

intellijPlatform {
    buildSearchableOptions.set(false)
    pluginConfiguration {
        id = "com.codepilot.idea"
        name = "CodePilot"
        version = project.version.toString()
        description = "CodePilot — headless coding agent client. Spawns `codepilot serve` over NDJSON JSON-RPC."
        changeNotes = "Initial scaffold: chat tool window, editor \"Ask CodePilot\" action, settings page."

        // Since/until — match IntelliJ Platform 2.x expectations (YYMM build numbers).
        ideaVersion {
            sinceBuild = "233"
            untilBuild = "251.*"
        }
    }

    // Sandbox used by `runIde` for manual testing.
    sandboxContainer.set(project.layout.buildDirectory.dir("idea-sandbox"))
}

// Tests are not yet provided; keep the configuration minimal but allow `./gradlew check`.
tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}