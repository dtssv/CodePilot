plugins {
    java
    id("org.cyclonedx.bom") version "1.9.0" apply false
    alias(libs.plugins.spring.boot) apply false
    alias(libs.plugins.spring.dependency.mgmt) apply false
    alias(libs.plugins.spotless) apply false
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0")

val catalog = the<VersionCatalogsExtension>().named("libs")

subprojects {
    apply {
        plugin("java")
        plugin("io.spring.dependency-management")
        plugin("com.diffplug.spotless")
    }

    val javaVersion = catalog.findVersion("java").get().requiredVersion.toInt()
    val lombokVersion = catalog.findVersion("lombok").get().requiredVersion
    val mapstructVersion = catalog.findVersion("mapstruct").get().requiredVersion
    val jacksonVersion = catalog.findVersion("jackson").get().requiredVersion
    val otelVersion = catalog.findVersion("otel").get().requiredVersion
    val junitVersion = catalog.findVersion("junit").get().requiredVersion

    extensions.configure<JavaPluginExtension> {
        withSourcesJar()
        withJavadocJar()
    }

    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.release.set(javaVersion)
        options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all"))
    }

    extensions.configure<io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension> {
        imports {
            mavenBom(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES)
            mavenBom("com.fasterxml.jackson:jackson-bom:$jacksonVersion")
            mavenBom("io.opentelemetry:opentelemetry-bom:$otelVersion")
            mavenBom("org.springframework.cloud:spring-cloud-dependencies:${catalog.findVersion("spring-cloud").get().requiredVersion}")
        }
    }

    dependencies {
        // Core Java amenities
        add("compileOnly", "org.projectlombok:lombok:$lombokVersion")
        add("annotationProcessor", "org.projectlombok:lombok:$lombokVersion")
        add("testCompileOnly", "org.projectlombok:lombok:$lombokVersion")
        add("testAnnotationProcessor", "org.projectlombok:lombok:$lombokVersion")

        add("annotationProcessor", "org.springframework.boot:spring-boot-configuration-processor")
        add("annotationProcessor", "org.mapstruct:mapstruct-processor:$mapstructVersion")
        add("compileOnly", "org.mapstruct:mapstruct:$mapstructVersion")

        // Testing
        add("testImplementation", platform("org.junit:junit-bom:$junitVersion"))
        add("testImplementation", "org.springframework.boot:spring-boot-starter-test") {
            exclude(group = "org.mockito") // we don't allow mock libs in production code or tests
        }
        add("testImplementation", "org.assertj:assertj-core:${catalog.findVersion("assertj").get().requiredVersion}")
        add("testImplementation", "org.testcontainers:junit-jupiter:${catalog.findVersion("testcontainers").get().requiredVersion}")
        add("testImplementation", "org.testcontainers:postgresql:${catalog.findVersion("testcontainers").get().requiredVersion}")
        add("testImplementation", "org.awaitility:awaitility:${catalog.findVersion("awaitility").get().requiredVersion}")
        add("testImplementation", "org.wiremock:wiremock-standalone:${catalog.findVersion("wiremock").get().requiredVersion}")
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