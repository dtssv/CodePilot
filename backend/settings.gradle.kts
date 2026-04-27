pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
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