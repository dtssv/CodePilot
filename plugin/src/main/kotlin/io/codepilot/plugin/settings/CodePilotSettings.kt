package io.codepilot.plugin.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil
import java.nio.file.Path
import java.util.UUID

/**
 * Persistent CodePilot settings.
 *
 * Sensitive material (JWT, refresh token, deviceSecret) lives in IntelliJ's [PasswordSafe]; the
 * non-sensitive bits live in this XML state.
 */
@State(
    name = "io.codepilot.settings",
    storages = [Storage("codePilot.xml")],
)
@Service(Service.Level.APP)
class CodePilotSettings : PersistentStateComponent<CodePilotSettings.State> {

    data class State(
        //prd
        //var backendBaseUrl: String = "https://api.codepilot.local",
        //dev
        var backendBaseUrl: String = "http://localhost:8080",
        var deviceId: String = UUID.randomUUID().toString(),
        var preferredLocale: String = "zh-CN",
        var sessionRoot: String = defaultSessionRoot(),
        var updateChannel: String = "stable",
        var contextBudgetTokens: Int = 24_000,
        var keepRecentMessages: Int = 6,
        var autoApplyLowRiskPatches: Boolean = false,
        var allowDevSso: Boolean = false,
        /** Dev token for bypassing JWT auth in development builds. Empty in production. */
        var devToken: String = "",
        /** ★ Privacy Mode: when true, no code/text is sent to the cloud; local-only. */
        var privacyMode: Boolean = false,
        /** ★ Local encryption for stored sessions when privacyMode is on. */
        var localEncryption: Boolean = false,
        /** ★ Anonymous telemetry mode: sends usage stats without PII. */
        var anonymousMode: Boolean = false,
        var registries: List<RegistryEntry> = listOf(
            RegistryEntry("Official", "https://marketplace.codepilot.io", "")
        ),
    )

    private var state: State = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        XmlSerializerUtil.copyBean(state, this.state)
        // Load devToken from bundled properties file (injected at build time)
        if (this.state.devToken.isEmpty()) {
            this.state.devToken = loadBundledDevToken()
        }
    }

    /** Try to load devToken from: 1) bundled properties, 2) env var CODEPILOT_DEV_TOKEN */
    private fun loadBundledDevToken(): String {
        val log = com.intellij.openapi.diagnostic.Logger.getInstance("CodePilotSettings")
        // 1) Try bundled properties file
        try {
            val stream = javaClass.getResourceAsStream("/codepilot-dev.properties")
            if (stream != null) {
                val props = java.util.Properties()
                stream.use { props.load(it) }
                val token = props.getProperty("devToken", "")
                if (token.isNotEmpty()) {
                    log.info("[Settings] devToken loaded from bundled properties (length=${token.length})")
                    return token
                }
                log.info("[Settings] codepilot-dev.properties found but devToken is empty")
            } else {
                log.info("[Settings] codepilot-dev.properties not found in classpath")
            }
        } catch (e: Exception) {
            log.warn("[Settings] Failed to read codepilot-dev.properties", e)
        }
        // 2) Fallback: try env var directly
        val envToken = System.getenv("CODEPILOT_DEV_TOKEN") ?: ""
        if (envToken.isNotEmpty()) {
            log.info("[Settings] devToken loaded from env var CODEPILOT_DEV_TOKEN (length=${envToken.length})")
        }
        return envToken
    }

    fun update(mutator: (State) -> Unit) {
        mutator(state)
    }

    fun sessionRootPath(): Path = Path.of(state.sessionRoot)

    /** Read the access token from the password safe. */
    fun accessToken(): String? = read(CredAttr.JWT)

    fun setAccessToken(token: String?) = write(CredAttr.JWT, token)

    fun refreshToken(): String? = read(CredAttr.REFRESH)

    fun setRefreshToken(token: String?) = write(CredAttr.REFRESH, token)

    fun deviceSecret(): String? = read(CredAttr.DEVICE_SECRET)

    fun setDeviceSecret(secret: String?) = write(CredAttr.DEVICE_SECRET, secret)

    private fun read(attr: CredentialAttributes): String? = PasswordSafe.instance.getPassword(attr)

    private fun write(attr: CredentialAttributes, value: String?) {
        if (value == null) PasswordSafe.instance.set(attr, null)
        else PasswordSafe.instance.set(attr, Credentials("codepilot", value))
    }

    private object CredAttr {
        val JWT = CredentialAttributes("io.codepilot.jwt")
        val REFRESH = CredentialAttributes("io.codepilot.refresh")
        val DEVICE_SECRET = CredentialAttributes("io.codepilot.device-secret")
    }

    companion object {
        fun defaultSessionRoot(): String =
            Path.of(System.getProperty("user.home"), ".codePilot", "sessions").toString()

        @JvmStatic fun getInstance(): CodePilotSettings = com.intellij.openapi.components.service()
    }
}