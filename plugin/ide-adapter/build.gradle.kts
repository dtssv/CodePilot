plugins {
    kotlin("jvm") version "2.3.0"
    id("org.jetbrains.intellij.platform.module")
}

group = "io.codepilot"
version = "1.0.0-SNAPSHOT"

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

// IntelliJ Platform dependency is inherited from the root plugin project's
// target (2024.2.3 + bundled java plugin) via the Module plugin; we only need
// Platform + bundled Java for PSI/VFS/Editor access.
dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2.3")
        bundledPlugin("com.intellij.java")
    }

    implementation(project(":harness-core"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
}
