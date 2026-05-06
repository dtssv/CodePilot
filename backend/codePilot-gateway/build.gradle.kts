plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-common"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation(libs.nimbus.jose.jwt)
    implementation(libs.bucket4j.core)
    implementation(libs.caffeine)
}