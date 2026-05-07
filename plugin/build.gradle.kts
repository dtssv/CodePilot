import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import java.util.Properties

plugins {
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
    id("org.jlleitschuh.gradle.ktlint") version "12.1.1"
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0-SNAPSHOT")

// Dev token: set CODEPILOT_DEV_TOKEN env var to embed a dev bypass token in the build.
// Empty string (default) means production build with no dev bypass.
val codePilotDevToken = providers.environmentVariable("CODEPILOT_DEV_TOKEN").getOrElse("")

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
        certificateChainFile = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_CHAIN").map { file(it) }
        privateKeyFile = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_KEY").map { file(it) }
        password = providers.environmentVariable("CODEPILOT_PLUGIN_CERT_PASSWORD")
    }
}

ktlint {
    version.set("1.3.1")
}

// ---- WebUI build integration ----

val webUiDir = project.file("webui")
val webUiDist = webUiDir.resolve("dist")
val webUiResourceDir = project.file("src/main/resources/webui/dist")

val webUiInstall by tasks.registering(Exec::class) {
    group = "webui"
    description = "Install WebUI npm dependencies"
    workingDir = webUiDir
    commandLine("npm", "install")
    inputs.file(webUiDir.resolve("package.json"))
    outputs.dir(webUiDir.resolve("node_modules"))
}

val webUiBuild by tasks.registering(Exec::class) {
    group = "webui"
    description = "Build WebUI (vite)"
    dependsOn(webUiInstall)
    workingDir = webUiDir
    commandLine("npm", "run", "build")
    inputs.dir(webUiDir.resolve("src"))
    inputs.file(webUiDir.resolve("index.html"))
    inputs.file(webUiDir.resolve("vite.config.ts"))
    inputs.file(webUiDir.resolve("tsconfig.json"))
    outputs.dir(webUiDist)
}

val copyWebUi by tasks.registering(Copy::class) {
    group = "webui"
    description = "Copy WebUI dist to plugin resources"
    dependsOn(webUiBuild)
    from(webUiDist)
    into(webUiResourceDir)
}

// Generate codepilot-dev.properties with devToken (if set) during build
val generateDevProps by tasks.registering {
    val outDir = layout.buildDirectory.dir("generated-resources")
    outputs.dir(outDir)
    doLast {
        val dir = outDir.get().asFile
        dir.mkdirs()
        val file = File(dir, "codepilot-dev.properties")
        if (codePilotDevToken.isNotEmpty()) {
            file.writeText("devToken=$codePilotDevToken\n")
        } else {
            file.writeText("")
        }
    }
}

// Wire WebUI build into the plugin lifecycle
tasks.named("processResources") {
    dependsOn(copyWebUi)
    dependsOn(generateDevProps)
}

// Include generated resources in the main sourceSet output
sourceSets {
    getByName("main") {
        resources {
            srcDir(layout.buildDirectory.dir("generated-resources"))
        }
    }
}

tasks {
    runIde {
        jvmArgs("-Xmx2g")
        dependsOn(copyWebUi)
    }
    test {
        useJUnitPlatform()
    }
    clean {
        delete(webUiResourceDir)
    }
}