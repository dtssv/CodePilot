# CodePilot — IntelliJ Platform Plugin

Kotlin 2.0 + IntelliJ Platform Gradle Plugin 2.x. Targets IDEA 2024.2+.

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