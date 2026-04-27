plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-common"))

    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation(rootProject.libs.nimbus.jose.jwt)
    implementation(rootProject.libs.bucket4j.core)
    implementation(rootProject.libs.caffeine)
}