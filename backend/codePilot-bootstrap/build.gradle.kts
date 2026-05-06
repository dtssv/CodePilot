plugins {
    alias(libs.plugins.spring.boot)
    java
    id("org.cyclonedx.bom")
}

dependencies {
    implementation(project(":codePilot-api"))
    implementation(project(":codePilot-core"))
    implementation(project(":codePilot-mcp-hub"))
    implementation(project(":codePilot-gateway"))
    implementation(project(":codePilot-common"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")

    implementation(libs.flyway.core)
    implementation(libs.flyway.postgres)
    implementation(libs.postgresql)
    implementation(libs.hikari)

    implementation(libs.micrometer.tracing.bridge.otel)
    implementation(libs.otel.exporter.otlp)

    implementation(libs.springdoc.openapi)
}

springBoot {
    mainClass.set("io.codepilot.bootstrap.CodePilotApplication")
    buildInfo()
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("codePilot-backend.jar")
}