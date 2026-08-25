pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

// Auto-download a JDK matching the toolchain (e.g. 21) from Adoptium if none is configured.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    @Suppress("UnstableApiUsage")
    repositories {
        mavenCentral()
        maven("https://repo.spring.io/milestone")
        maven("https://repo.spring.io/snapshot")
    }
    @Suppress("UnstableApiUsage")
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
}

rootProject.name = "codePilot-backend"

include(
    ":codePilot-common",
    ":codePilot-core",
    ":codePilot-api",
    ":codePilot-mcp-hub",
    ":codePilot-gateway",
    ":codePilot-bootstrap",
)