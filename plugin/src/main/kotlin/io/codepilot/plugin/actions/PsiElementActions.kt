package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiMethod
import io.codepilot.plugin.toolwindow.CefChatPanelRegistry
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Base action for PSI-element-scoped actions (class or method level).
 * Extracts the element's source code, opens the chat panel, and dispatches
 * the action prompt so the LLM can generate the requested artifact.
 */
abstract class PsiElementActionBase(
    private val action: String,
    private val instruction: String,
) : AnAction() {
    override fun update(e: AnActionEvent) {
        val element = e.getData(CommonDataKeys.PSI_ELEMENT)
        e.presentation.isEnabledAndVisible = element is PsiClass || element is PsiMethod
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val element = e.getData(CommonDataKeys.PSI_ELEMENT) as? PsiElement ?: return
        val code = element.text ?: return
        val name =
            when (element) {
                is PsiClass -> element.name ?: "Class"
                is PsiMethod -> element.name ?: "Method"
                else -> "Element"
            }
        val kind =
            when (element) {
                is PsiClass -> "class"
                is PsiMethod -> "method"
                else -> "element"
            }
        val lang = element.language?.id ?: "java"

        val input = "[$action] $kind: $name\n$instruction\n\n```$lang\n$code\n```"

        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            ApplicationManager.getApplication().invokeLater {
                val panel = CefChatPanelRegistry.getInstance(project)
                if (panel != null) {
                    panel.dispatchToWeb(
                        "action_start",
                        mapOf(
                            "action" to action,
                            "display" to "$action: $kind $name",
                            "instruction" to instruction,
                        ),
                    )
                    // Use ActionBase's SSE call mechanism by creating a simple SSE call
                    callActionSse(panel, input, lang, name)
                } else {
                    ClipboardBridge.push(input, null)
                }
            }
        }
    }

    private fun callActionSse(
        panel: io.codepilot.plugin.toolwindow.CefChatPanel,
        input: String,
        lang: String,
        elementName: String,
    ) {
        val settings =
            io.codepilot.plugin.settings.CodePilotSettings
                .getInstance()
        val http =
            io.codepilot.plugin.transport.HttpClientService
                .getInstance()
        val mapper =
            com.fasterxml.jackson.databind
                .ObjectMapper()
        val sessionId =
            java.util.UUID
                .randomUUID()
                .toString()

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val url =
                    (settings.state.backendBaseUrl.trimEnd('/') + "/v1/actions/$action")
                        .toHttpUrl()
                val body =
                    mapper.writeValueAsString(
                        mapOf(
                            "sessionId" to sessionId,
                            "modelId" to null,
                            "context" to input,
                            "instruction" to instruction,
                            "language" to lang,
                        ),
                    )
                val request =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .post(body.toRequestBody("application/json".toMediaType()))
                        .header("Accept", "text/event-stream")
                        .build()

                val collector = StringBuilder()

                http.openSse(
                    request,
                    object : okhttp3.sse.EventSourceListener() {
                        override fun onEvent(
                            eventSource: okhttp3.sse.EventSource,
                            id: String?,
                            type: String?,
                            data: String,
                        ) {
                            val node = mapper.readTree(data.ifEmpty { "{}" })
                            when (type) {
                                "delta" -> {
                                    val text = node.path("text").asText("")
                                    if (text.isNotEmpty()) {
                                        collector.append(text)
                                        panel.dispatchToWeb("delta", mapOf("text" to text))
                                    }
                                }
                                "patch" -> {
                                    val patchData = mapper.treeToValue(node, Map::class.java)
                                    panel.dispatchToWeb("patch", patchData)
                                }
                                "error" -> {
                                    val code = node.path("code").asInt(50001)
                                    val msg = node.path("message").asText("")
                                    panel.dispatchToWeb("error", mapOf("code" to code, "message" to msg))
                                }
                                "done" -> {
                                    panel.dispatchToWeb("done", mapOf("reason" to node.path("reason").asText("final")))
                                }
                            }
                        }

                        override fun onClosed(eventSource: okhttp3.sse.EventSource) {
                            if (collector.isNotEmpty()) {
                                panel.dispatchToWeb("action_done", mapOf("action" to action, "result" to collector.toString()))
                            }
                        }

                        override fun onFailure(
                            eventSource: okhttp3.sse.EventSource,
                            t: Throwable?,
                            response: okhttp3.Response?,
                        ) {
                            response?.close()
                            panel.dispatchToWeb("error", mapOf("code" to 50002, "message" to (t?.message ?: "SSE failed")))
                        }
                    },
                )
            } catch (e: Exception) {
                panel.dispatchToWeb("error", mapOf("code" to 50001, "message" to (e.message ?: "Unknown error")))
            }
        }
    }
}

/** Generate unit tests for the selected class or method. */
class PsiGenTestAction :
    PsiElementActionBase("gentest", "Generate unit tests covering happy-path and edge cases. Return a Patch JSON creating the test file.")

/** Generate documentation for the selected class or method. */
class PsiGenDocAction :
    PsiElementActionBase(
        "gendoc",
        "Produce developer documentation (KDoc/Javadoc) for the following element. Return a Patch JSON with the comments inserted.",
    )

/** Generate comments for the selected class or method. */
class PsiCommentAction :
    PsiElementActionBase("comment", "Add idiomatic inline comments and doc comments without altering executable code. Return a Patch JSON.")
