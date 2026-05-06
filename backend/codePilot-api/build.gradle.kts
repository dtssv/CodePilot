plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation(libs.springdoc.openapi)
    implementation(libs.resilience4j.spring.boot3)
    implementation(libs.bucket4j.core)
}