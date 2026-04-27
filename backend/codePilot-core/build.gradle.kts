plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-common"))

    api(rootProject.libs.spring.ai.openai)
    api(rootProject.libs.spring.ai.pgvector)
    api(rootProject.libs.spring.ai.mcp)

    api(rootProject.libs.caffeine)
    api(rootProject.libs.json.schema.validator)
    api(rootProject.libs.jtokkit)
    api(rootProject.libs.bouncycastle.bcpkix)

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("com.fasterxml.jackson.core:jackson-databind")
    implementation("com.fasterxml.jackson.core:jackson-annotations")
}