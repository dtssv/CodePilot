package io.codepilot.plugin.update

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request

/**
 * Queries {@code GET /v1/plugin/manifest} in the background and surfaces an IDE notification when a
 * newer version is available on the configured channel. Hot-patch application is a later
 * milestone; here we only do the "check + notify" flow.
 */
@Service(Service.Level.APP)
class UpdateService {
    fun checkInBackground(project: Project?) {
        val http = HttpClientService.getInstance()
        val settings = CodePilotSettings.getInstance()

        val base =
            settings.state.backendBaseUrl
                .trimEnd('/')
                .toHttpUrl()
        val url =
            base
                .newBuilder()
                .addPathSegments("v1/plugin/manifest")
                .addQueryParameter("channel", settings.state.updateChannel)
                .addQueryParameter("ideBuild", ApplicationInfo.getInstance().build.asString())
                .addQueryParameter("deviceId", settings.state.deviceId)
                .build()

        val request =
            Request
                .Builder()
                .url(url)
                .get()
                .header("Accept", "application/json")
                .build()
        http.client().newCall(request).enqueue(
            object : okhttp3.Callback {
                override fun onFailure(
                    call: okhttp3.Call,
                    e: java.io.IOException,
                ) = Unit // Silent.

                override fun onResponse(
                    call: okhttp3.Call,
                    response: okhttp3.Response,
                ) {
                    response.use {
                        if (!it.isSuccessful) return
                        val node: JsonNode = http.mapper.readTree(it.body!!.byteStream())
                        val data = node.path("data")
                        val remote = data.path("version").asText(null) ?: return
                        val rolledOut = data.path("rolledOut").asBoolean(true)
                        if (!rolledOut) return
                        val current = thisPluginVersion()
                        if (remote == current) return
                        notifyAvailable(project, remote, data)
                    }
                }
            },
        )
    }

    private fun notifyAvailable(
        project: Project?,
        remote: String,
        data: JsonNode,
    ) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup("CodePilot")
        group
            .createNotification(
                "CodePilot $remote is available",
                "Open Settings → CodePilot to switch channels or trigger a restart update.",
                NotificationType.INFORMATION,
            ).notify(project)
    }

    private fun thisPluginVersion(): String {
        val descriptor =
            com.intellij.ide.plugins.PluginManagerCore.getPlugin(
                com.intellij.openapi.extensions.PluginId
                    .getId("io.codepilot.intellij"),
            )
        return descriptor?.version ?: "0.0.0"
    }

    companion object {
        @JvmStatic fun getInstance(): UpdateService = service()
    }
}
