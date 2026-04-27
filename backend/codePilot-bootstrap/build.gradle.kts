plugins {
    alias(rootProject.libs.plugins.spring.boot)
    java
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

    implementation(rootProject.libs.flyway.core)
    implementation(rootProject.libs.flyway.postgres)
    implementation(rootProject.libs.postgresql)
    implementation(rootProject.libs.hikari)

    implementation(rootProject.libs.micrometer.tracing.bridge.otel)
    implementation(rootProject.libs.otel.exporter.otlp)

    implementation(rootProject.libs.springdoc.openapi)
}

springBoot {
    mainClass.set("io.codepilot.bootstrap.CodePilotApplication")
    buildInfo()
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("codePilot-backend.jar")
}