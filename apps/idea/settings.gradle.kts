pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

// Auto-provision the JDK 17 toolchain (gradle.properties sets auto-download=true).
// Without this resolver, Gradle can only *use* an already-installed JDK 17; with
// it, Gradle downloads one on demand so builds are reproducible on machines (and
// CI) that lack a local Java 17 install.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    // IntelliJ Platform artifacts (`ideaIC`, bundled plugins, JetBrains Runtime) live on JetBrains'
    // intellij-repository. The `idea:ideaIC` notation used by the plugin resolves here.
    repositories {
        mavenCentral()
        maven(url = "https://www.jetbrains.com/intellij-repository/releases") {
            name = "JetBrainsIntelliJRepo"
        }
        maven(url = "https://cache-redirector.jetbrains.com/intellij-dependencies") {
            name = "JetBrainsDepsCache"
        }
    }
}

rootProject.name = "codepilot-idea"