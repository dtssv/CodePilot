plugins {
    java
    alias(libs.plugins.spring.boot) apply false
    alias(libs.plugins.spring.dependency.mgmt) apply false
    alias(libs.plugins.spotless) apply false
}

group = "io.codepilot"
version = providers.gradleProperty("codePilotVersion").getOrElse("1.0.0")

subprojects {
    apply {
        plugin("java")
        plugin("io.spring.dependency-management")
        plugin("com.diffplug.spotless")
    }

    val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")

    extensions.configure<JavaPluginExtension> {
        toolchain {
            languageVersion.set(JavaLanguageVersion.of(libs.findVersion("java").get().requiredVersion.toInt()))
        }
        withSourcesJar()
        withJavadocJar()
    }

    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.release.set(libs.findVersion("java").get().requiredVersion.toInt())
        options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all", "-Werror"))
    }

    extensions.configure<io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension> {
        imports {
            mavenBom(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES)
            mavenBom("com.fasterxml.jackson:jackson-bom:${libs.findVersion("jackson").get().requiredVersion}")
            mavenBom("io.opentelemetry:opentelemetry-bom:${libs.findVersion("otel").get().requiredVersion}")
        }
    }

    dependencies {
        // Core Java amenities
        val lombokVer = libs.findVersion("lombok").get().requiredVersion
        add("compileOnly", "org.projectlombok:lombok:$lombokVer")
        add("annotationProcessor", "org.projectlombok:lombok:$lombokVer")
        add("testCompileOnly", "org.projectlombok:lombok:$lombokVer")
        add("testAnnotationProcessor", "org.projectlombok:lombok:$lombokVer")

        add("annotationProcessor", "org.springframework.boot:spring-boot-configuration-processor")
        val mapstructVer = libs.findVersion("mapstruct").get().requiredVersion
        add("annotationProcessor", "org.mapstruct:mapstruct-processor:$mapstructVer")
        add("compileOnly", "org.mapstruct:mapstruct:$mapstructVer")

        // Testing
        add("testImplementation", platform("org.junit:junit-bom:${libs.findVersion("junit").get().requiredVersion}"))
        add("testImplementation", libs.findLibrary("spring-boot-starter-test").get()) {
            exclude(group = "org.mockito") // we don't allow mock libs in production code or tests
        }
        add("testImplementation", libs.findLibrary("assertj-core").get())
        add("testImplementation", libs.findLibrary("testcontainers-junit-jupiter").get())
        add("testImplementation", libs.findLibrary("testcontainers-postgresql").get())
        add("testImplementation", libs.findLibrary("awaitility").get())
        add("testImplementation", libs.findLibrary("wiremock-jetty12").get())
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