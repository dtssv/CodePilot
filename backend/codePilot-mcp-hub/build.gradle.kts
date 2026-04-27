plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation(rootProject.libs.flyway.core)
    implementation(rootProject.libs.flyway.postgres)
    implementation(rootProject.libs.postgresql)
    implementation(rootProject.libs.hikari)
}