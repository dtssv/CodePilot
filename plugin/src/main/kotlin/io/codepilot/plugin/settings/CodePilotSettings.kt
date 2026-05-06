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
        var backendBaseUrl: String = "https://api.codepilot.local",
        var deviceId: String = UUID.randomUUID().toString(),
        var preferredLocale: String = "zh-CN",
        var sessionRoot: String = defaultSessionRoot(),
        var updateChannel: String = "stable",
        var contextBudgetTokens: Int = 24_000,
        var keepRecentMessages: Int = 6,
        var autoApplyLowRiskPatches: Boolean = false,
        var allowDevSso: Boolean = false,
    )

    private var state: State = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        XmlSerializerUtil.copyBean(state, this.state)
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