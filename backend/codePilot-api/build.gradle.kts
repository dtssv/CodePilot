plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))
    api(project(":codePilot-gateway"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation(rootProject.libs.springdoc.openapi)
    implementation(rootProject.libs.resilience4j.spring.boot3)
    implementation(rootProject.libs.bucket4j.core)
    implementation(rootProject.libs.nimbus.jose.jwt)
}