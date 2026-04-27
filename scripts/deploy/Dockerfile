# syntax=docker/dockerfile:1.7

# --- Build stage -----------------------------------------------------------
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /workspace

# Copy backend sources
COPY backend/ backend/

RUN --mount=type=cache,target=/root/.gradle \
    cd backend && ./gradlew --no-daemon :codePilot-bootstrap:bootJar

# --- Runtime stage ---------------------------------------------------------
FROM eclipse-temurin:21-jre-alpine
LABEL org.opencontainers.image.source="https://github.com/codePilot/CodePilot" \
      org.opencontainers.image.description="CodePilot backend (Spring Boot 3.3 + Spring AI 1.0)" \
      org.opencontainers.image.licenses="MIT"

ENV JAVA_TOOL_OPTIONS="-XX:+UseG1GC -XX:MaxRAMPercentage=75.0 -Dfile.encoding=UTF-8 -Djava.security.egd=file:/dev/./urandom"

# Non-root user
RUN addgroup -S codepilot && adduser -S codepilot -G codepilot -h /opt/codepilot
USER codepilot
WORKDIR /opt/codepilot

COPY --chown=codepilot:codepilot --from=builder /workspace/backend/codePilot-bootstrap/build/libs/codePilot-backend.jar app.jar

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/actuator/health | grep -q '"status":"UP"'

ENTRYPOINT ["java","-jar","/opt/codepilot/app.jar"]