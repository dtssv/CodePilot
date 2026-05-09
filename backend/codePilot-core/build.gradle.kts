plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-common"))

    api(libs.spring.ai.openai)
    api(libs.spring.ai.alibaba.graph)
    // api(libs.spring.ai.mcp)  // TODO: verify artifact coordinates for Spring AI MCP

    api(libs.caffeine)
    api(libs.json.schema.validator)
    api(libs.jtokkit)
    api(libs.bouncycastle.bcpkix)

    api("com.fasterxml.jackson.dataformat:jackson-dataformat-yaml")

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
}