# CodePilot — IntelliJ Platform Plugin

Kotlin 2.1 + IntelliJ Platform Gradle Plugin 2.x. Targets IDEA 2024.2+.

## JDK for Gradle / Kotlin compilation

Kotlin targets **Java 21** bytecode (`kotlin.jvmToolchain` + `java.toolchain`). Gradle also uses a **JDK 21** toolchain for compilation workers when available.

Kotlin’s compiler bundles `JavaVersion` parsing that historically **mis-handles running Gradle on very new JDKs** (you may see `IllegalArgumentException: 25.x` or Kotlin daemon incremental-cache crashes on `proto.tab`). **`JAVA_HOME` should point at JDK 21 while building this module**, even if day-to-day tooling uses JDK 25+:

```bash
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"   # macOS example
```

Or set `org.gradle.java.home=/path/to/jdk-21` in `plugin/gradle.properties` for this checkout only.

If you previously hit Kotlin daemon incremental-cache corruption:

```bash
./gradlew --stop
rm -rf build/kotlin
./gradlew clean compileKotlin
```

**Integrations UX:** With the WebUI (JCEF) chat enabled, Skill + MCP are configured only inside the embedded app nav (**集成**). A second IDE tool-window tab named integrations is registered only when JCEF is off (Swing chat fallback).

## Build & run

```bash
cd plugin
./gradlew runIde         # spin up a sandbox IDE with the plugin
./gradlew buildPlugin    # produces build/distributions/codePilot-<ver>.zip
```

## Anatomy

| Area | Path |
|---|---|
| Settings + credentials (PasswordSafe) | `plugin/src/main/kotlin/io/codepilot/plugin/settings/` |
| HTTP / SSE transport (OkHttp + HMAC) | `.../plugin/transport/` |
| Auth (login + OIDC device flow) | `.../plugin/auth/` |
| Conversation client (SSE listener) | `.../plugin/conversation/` |
| Local session store | `.../plugin/session/` |
| ToolWindow + Chat panel | `.../plugin/toolwindow/` |
| Marketplace Tab + Store | `.../plugin/marketplace/` |
| MCP subprocess manager | `.../plugin/mcp/` |
| Editor / project actions | `.../plugin/actions/` |
| Reset commands + sentinel handling | `.../plugin/reset/` |
| Self-update | `.../plugin/update/` |
| Plugin descriptor | `src/main/resources/META-INF/plugin.xml` |

## First-time login

1. Open Settings → Tools → CodePilot, set the backend Base URL.
2. Tools → "Open CodePilot chat" → the panel calls `GET /v1/auth/methods` to learn enabled SSO modes.
3. Pick one of:
   - **OIDC Device Flow**: the panel polls `/v1/auth/device-token` after browser login.
   - **Corporate SSO bridge**: paste the bootstrap token from your SSO Adapter.
   - **Dev SSO**: only when the backend has dev mode enabled and `Allow Dev SSO` is set.
4. The plugin stores `accessToken / refreshToken / deviceSecret` in IntelliJ's PasswordSafe.

## External reset (when the IDE is frozen)

```bash
touch ~/.codePilot/flags/reset_hard_local
# next IDE startup detects this, renames ~/.codePilot, and starts clean
```

See [docs/02-插件端设计.md §15](../docs/02-插件端设计.md) for full reset semantics.