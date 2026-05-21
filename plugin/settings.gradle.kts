pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        maven("https://cache-redirector.jetbrains.com/intellij-repository/releases")
    }
}

// Auto-download a JDK matching kotlin.jvmToolchain (e.g. 21) from Adoptium if none is configured.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "codePilot-plugin"
