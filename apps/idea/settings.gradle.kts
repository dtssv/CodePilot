pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
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