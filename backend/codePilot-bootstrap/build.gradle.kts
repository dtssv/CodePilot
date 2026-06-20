plugins {
    alias(libs.plugins.spring.boot)
    java
}

dependencies {
    implementation(project(":codePilot-api"))
    implementation(project(":codePilot-core"))
    implementation(project(":codePilot-mcp-hub"))
    implementation(project(":codePilot-gateway"))
    implementation(project(":codePilot-common"))

    implementation("org.springframework.boot:spring-boot-starter-web") {
        exclude(group = "org.springframework.boot", module = "spring-boot-starter-tomcat")
    }
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")

    implementation(libs.mysql.connector)
    implementation(libs.hikari)

    implementation("io.micrometer:micrometer-tracing-bridge-otel")
    implementation(libs.otel.exporter.otlp)

    implementation(libs.springdoc.openapi)

    // Native DNS resolver for macOS — prevents ERROR at startup:
    // "Unable to load io.netty.resolver.dns.macos.MacOSDnsServerAddressStreamProvider"
    // Version is managed by the Spring Boot BOM (netty.version property).
    val osArch = if (System.getProperty("os.arch") == "aarch64") "osx-aarch_64" else "osx-x86_64"
    implementation("io.netty:netty-resolver-dns-native-macos::$osArch")
}

springBoot {
    mainClass.set("io.codepilot.bootstrap.CodePilotApplication")
    buildInfo()
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("codePilot-backend.jar")
}
