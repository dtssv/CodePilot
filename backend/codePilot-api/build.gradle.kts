plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))
    implementation(project(":codePilot-gateway"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation(libs.springdoc.openapi)
    implementation(libs.resilience4j.spring.boot3)
    implementation(libs.bucket4j.core)
    implementation(libs.nimbus.jose.jwt)
}