plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-common"))

    api(libs.spring.ai.openai)
    api(libs.spring.ai.alibaba.graph)
    // api(libs.spring.ai.mcp)  // TODO: MCP client starter optional

    api(libs.caffeine)
    api(libs.json.schema.validator)
    api(libs.jtokkit)
    api(libs.bouncycastle.bcpkix)

    api("com.fasterxml.jackson.dataformat:jackson-dataformat-yaml")
    api("com.google.code.gson:gson")

    // GraalVM polyglot + JS (community) for the Dynamic Workflow sandbox
    implementation("org.graalvm.polyglot:polyglot:24.1.1")
    implementation("org.graalvm.polyglot:js-community:24.1.1")

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-actuator")

    // OpenTelemetry for distributed tracing
    implementation("io.opentelemetry:opentelemetry-api")
    implementation("io.opentelemetry:opentelemetry-sdk")
    implementation("io.opentelemetry:opentelemetry-exporter-otlp")
    implementation(libs.otel.semconv.incubating)
    implementation(libs.okhttp)
}
