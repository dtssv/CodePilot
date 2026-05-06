import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
    id("org.jlleitschuh.gradle.ktlint") version "12.1.1"
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0-SNAPSHOT")

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
        instrumentationTools()
        testFramework(TestFrameworkType.Platform)
    }

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testImplementation("org.assertj:assertj-core:3.26.3")
}

intellijPlatform {
    pluginConfiguration {
        id = "io.codepilot.intellij"
        name = "CodePilot"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "232"
            untilBuild = provider { null }
        }
        vendor {
            name = "CodePilot"
            email = "dev@codepilot.local"
            url = "https://example.com/codepilot"
        }
        description = "CodePilot AI coding assistant for JetBrains IDEs."
        changeNotes = "See CHANGELOG.md for details."
    }

    buildSearchableOptions = false

    signing {
        // Set CODEPILOT_PLUGIN_CERT_CHAIN / KEY / PASSWORD to enable signing.
        certificateChainFile = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_CHAIN").map { file(it) }
        privateKeyFile = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_KEY").map { file(it) }
        password = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_PASSWORD")
    }
}

ktlint {
    version.set("1.3.1")
}

tasks {
    runIde {
        jvmArgs("-Xmx2g")
    }
    test {
        useJUnitPlatform()
    }
}