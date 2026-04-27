plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation(rootProject.libs.springdoc.openapi)
    implementation(rootProject.libs.resilience4j.spring.boot3)
    implementation(rootProject.libs.bucket4j.core)
}