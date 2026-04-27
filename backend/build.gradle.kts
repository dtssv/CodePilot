plugins {
    java
    alias(libs.plugins.spring.boot) apply false
    alias(libs.plugins.spring.dependency.mgmt) apply false
    alias(libs.plugins.spotless) apply false
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0")

allprojects {
    repositories {
        mavenCentral()
        maven("https://repo.spring.io/milestone")
        maven("https://repo.spring.io/snapshot")
    }
}

subprojects {
    apply {
        plugin("java")
        plugin("io.spring.dependency-management")
        plugin("com.diffplug.spotless")
    }

    extensions.configure<JavaPluginExtension> {
        toolchain {
            languageVersion.set(JavaLanguageVersion.of(libs.versions.java.get().toInt()))
        }
        withSourcesJar()
        withJavadocJar()
    }

    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.release.set(libs.versions.java.get().toInt())
        options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all", "-Werror"))
    }

    extensions.configure<io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension> {
        imports {
            mavenBom(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES)
            mavenBom("com.fasterxml.jackson:jackson-bom:${libs.versions.jackson.get()}")
            mavenBom("io.opentelemetry:opentelemetry-bom:${libs.versions.otel.get()}")
        }
    }

    dependencies {
        // Core Java amenities
        add("compileOnly", "org.projectlombok:lombok:${libs.versions.lombok.get()}")
        add("annotationProcessor", "org.projectlombok:lombok:${libs.versions.lombok.get()}")
        add("testCompileOnly", "org.projectlombok:lombok:${libs.versions.lombok.get()}")
        add("testAnnotationProcessor", "org.projectlombok:lombok:${libs.versions.lombok.get()}")

        add("annotationProcessor", "org.springframework.boot:spring-boot-configuration-processor")
        add("annotationProcessor", libs.mapstruct.processor.get())
        add("compileOnly", libs.mapstruct.get())

        // Testing
        add("testImplementation", platform("org.junit:junit-bom:${libs.versions.junit.get()}"))
        add("testImplementation", libs.spring.boot.starter.test.get()) {
            exclude(group = "org.mockito") // we don't allow mock libs in production code or tests
        }
        add("testImplementation", libs.assertj.core.get())
        add("testImplementation", libs.testcontainers.junit.jupiter.get())
        add("testImplementation", libs.testcontainers.postgresql.get())
        add("testImplementation", libs.awaitility.get())
        add("testImplementation", libs.wiremock.jetty12.get())
    }

    extensions.configure<com.diffplug.gradle.spotless.SpotlessExtension> {
        java {
            googleJavaFormat("1.22.0").reflowLongStrings()
            removeUnusedImports()
            trimTrailingWhitespace()
            endWithNewline()
            target("src/**/*.java")
        }
        kotlinGradle {
            ktlint("1.3.1")
            target("*.gradle.kts")
        }
        format("misc") {
            target("*.md", "*.gitignore", "*.yml", "*.yaml")
            trimTrailingWhitespace()
            endWithNewline()
        }
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("passed", "skipped", "failed")
            showStandardStreams = false
        }
        // Real services policy: do not allow Mockito on classpath of integration tests
        systemProperty("codepilot.no-mocks", "true")
    }
}