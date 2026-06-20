plugins {
    `java-library`
}

dependencies {
    api(project(":codePilot-core"))
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation(libs.mysql.connector)
    implementation(libs.hikari)
}
