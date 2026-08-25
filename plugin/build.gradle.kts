import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    kotlin("jvm") version "2.3.0"
    id("org.jetbrains.intellij.platform") version "2.18.1"
    id("org.jlleitschuh.gradle.ktlint") version "12.1.1"
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0-SNAPSHOT")

// Dev token: set CODEPILOT_DEV_TOKEN env var to embed a dev bypass token in the build.
// Empty string (default) means production build with no dev bypass.
val codePilotDevToken = providers.environmentVariable("CODEPILOT_DEV_TOKEN").getOrElse("")
/** When false, hides dev sign-in in WebUI (set CODEPILOT_DEV_LOGIN_UI=false at build time). */
val codePilotDevLoginUi = providers.environmentVariable("CODEPILOT_DEV_LOGIN_UI").getOrElse("true")

kotlin {
    jvmToolchain(21)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2.3")
        bundledPlugin("com.intellij.java")
        testFramework(TestFrameworkType.Platform)
    }

    // New layered architecture: harness-core (pure JVM) + ide-adapter (IDE bridge)
    // + tools-ide (IDE-backed tool shells). The legacy plugin/src/.../tools/*
    // implementations are being migrated to tools-ide and will be deleted.
    implementation(project(":harness-core"))
    implementation(project(":ide-adapter"))
    implementation(project(":tools-ide"))

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
val npmExecutable = if (System.getProperty("os.name").lowercase().contains("windows")) "npm.cmd" else "npm"

val webUiInstall = tasks.register<Exec>("webUiInstall") {
    group = "webui"
    description = "Install WebUI npm dependencies"
    workingDir = webUiDir
    commandLine(npmExecutable, "install")
    inputs.file(webUiDir.resolve("package.json"))
    inputs.file(webUiDir.resolve("package-lock.json"))
    outputs.dir(webUiDir.resolve("node_modules"))
}

val webUiBuild = tasks.register<Exec>("webUiBuild") {
    group = "webui"
    description = "Build WebUI (vite)"
    dependsOn(webUiInstall)
    workingDir = webUiDir
    environment("CODEPILOT_DEV_LOGIN_UI", codePilotDevLoginUi)
    commandLine(npmExecutable, "run", "build")
    inputs.dir(webUiDir.resolve("src"))
    inputs.file(webUiDir.resolve("index.html"))
    inputs.file(webUiDir.resolve("vite.config.ts"))
    inputs.file(webUiDir.resolve("tsconfig.json"))
    outputs.dir(webUiDist)
}

val copyWebUi = tasks.register<Copy>("copyWebUi") {
    group = "webui"
    description = "Copy WebUI dist to plugin resources"
    dependsOn(webUiBuild)
    from(webUiDist)
    into(webUiResourceDir)
}

// Generate codepilot-dev.properties with devToken (if set) during build
val generateDevProps = tasks.register("generateDevProps") {
    val outDir = layout.buildDirectory.dir("generated-resources")
    outputs.dir(outDir)
    doLast {
        val dir = outDir.get().asFile
        dir.mkdirs()
        val file = File(dir, "codepilot-dev.properties")
        file.writeText(
            buildString {
                if (codePilotDevToken.isNotEmpty()) {
                    appendLine("devToken=$codePilotDevToken")
                }
                appendLine("devLoginEnabled=$codePilotDevLoginUi")
            },
        )
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

// ---- Protocol v3 events validation ----
// Lightweight CI guard: validates that every .jsonl fixture under
// protocol/v3/fixtures conforms to the events schema's field whitelist.
// Full JSON-Schema validation runs in the backend module (which already has
// Jackson + json-schema-validator on its test classpath).
val validateEventsJson = tasks.register("validateEventsJson") {
    group = "verification"
    description = "Validate protocol/v3 NDJSON fixtures against events.schema.json field whitelist."
    val schema = rootProject.file("protocol/v3/events.schema.json")
    val fixturesDir = rootProject.file("protocol/v3/fixtures")
    inputs.file(schema)
    if (fixturesDir.exists()) inputs.dir(fixturesDir)
    doLast {
        val allowedTypes = listOf(
            "run_started", "user_message_added", "assistant_message_added",
            "tool_result_added", "permission_decision_recorded",
            "compaction_applied", "run_finished",
        )
        var errors = 0
        if (!schema.exists()) throw GradleException("schema not found: ${schema}")
        if (!fixturesDir.exists()) return@doLast
        fixturesDir.walkTopDown().filter { it.isFile && it.extension == "jsonl" }.forEach { f ->
            f.useLines { lines ->
                lines.forEachIndexed { i, line ->
                    val trimmed = line.trim()
                    if (trimmed.isEmpty() || trimmed.startsWith("#")) return@forEachIndexed
                    val type = Regex("\"type\"\\s*:\\s*\"([a-z_]+)\"").find(trimmed)
                        ?.groupValues?.get(1)
                    if (type == null || type !in allowedTypes) {
                        logger.error("[validateEventsJson] ${f.name}:${i + 1} invalid or unknown type: $type")
                        errors++
                    }
                    if (!trimmed.contains("\"seq\"") || !trimmed.contains("\"ts\"")) {
                        logger.error("[validateEventsJson] ${f.name}:${i + 1} missing seq/ts")
                        errors++
                    }
                }
            }
        }
        if (errors > 0) throw GradleException("validateEventsJson: $errors error(s)")
        logger.lifecycle("validateEventsJson: fixtures OK")
    }
}
tasks.named("check") { dependsOn("validateEventsJson") }
