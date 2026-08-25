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

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2.3")
        bundledPlugin("com.intellij.java")
    }

    implementation(project(":harness-core"))
    implementation(project(":ide-adapter"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
}
