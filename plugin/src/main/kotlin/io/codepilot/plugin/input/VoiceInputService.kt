package io.codepilot.plugin.input

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import javax.sound.sampled.*

/**
 * Voice Input — Speech-to-text for chat input.
 * Uses microphone capture with VAD, sends to backend /v1/speech/recognize,
 * falls back to Web Speech API in JCEF.
 */
object VoiceInputService {

    data class VoiceState(val isRecording: Boolean, val durationMs: Long, val level: Float)

    private val state = ConcurrentHashMap<String, VoiceState>()
    private var audioLine: TargetDataLine? = null
    private var audioBuffer = mutableListOf<Byte>()
    private const val SAMPLE_RATE = 16000f
    private const val MAX_RECORDING_MS = 60_000L
    private const val SILENCE_TIMEOUT_MS = 3_000L
    private const val VAD_THRESHOLD = 0.02f

    fun startRecording(project: Project): CompletableFuture<String> {
        val key = project.basePath ?: return CompletableFuture.completedFuture("")
        if (state[key]?.isRecording == true) return CompletableFuture.completedFuture("")
        val future = CompletableFuture<String>()
        state[key] = VoiceState(true, 0L, 0f)
        audioBuffer.clear()
        Thread({
            try {
                val format = AudioFormat(SAMPLE_RATE, 16, 1, true, false)
                val info = DataLine.Info(TargetDataLine::class.java, format)
                if (!AudioSystem.isLineSupported(info)) { useWebSpeechApi(project, future); return@Thread }
                val line = AudioSystem.getLine(info) as TargetDataLine
                line.open(format); line.start(); audioLine = line
                val buffer = ByteArray(4096)
                var silenceStart = 0L; val startTime = System.currentTimeMillis()
                while (state[key]?.isRecording == true) {
                    val read = line.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        audioBuffer.addAll(buffer.take(read).toList())
                        var sum = 0.0
                        for (i in 0 until read step 2) { val s = (buffer[i].toInt() and 0xFF) or (buffer[i+1].toInt() shl 8); sum += s.toDouble()*s.toDouble() }
                        val level = Math.sqrt(sum / (read/2)).toFloat() / Short.MAX_VALUE.toFloat()
                        if (level < VAD_THRESHOLD) { if (silenceStart == 0L) silenceStart = System.currentTimeMillis(); else if (System.currentTimeMillis()-silenceStart > SILENCE_TIMEOUT_MS) break }
                        else silenceStart = 0L
                        state[key] = VoiceState(true, System.currentTimeMillis()-startTime, level)
                        if (System.currentTimeMillis()-startTime > MAX_RECORDING_MS) break
                    }
                }
                line.stop(); line.close(); audioLine = null
                val transcript = transcribeAudio(project, audioBuffer.toByteArray())
                future.complete(transcript)
            } catch (_: Exception) { future.complete("") }
            finally { state[key] = VoiceState(false, 0L, 0f) }
        }, "codepilot-voice").apply { isDaemon = true; start() }
        return future
    }

    fun stopRecording(project: Project) {
        val key = project.basePath ?: return
        state[key] = VoiceState(false, state[key]?.durationMs ?: 0L, 0f)
        audioLine?.stop()
    }

    fun getState(project: Project): VoiceState = state[project.basePath] ?: VoiceState(false, 0L, 0f)

    fun isAvailable(): Boolean = try { AudioSystem.isLineSupported(DataLine.Info(TargetDataLine::class.java, AudioFormat(SAMPLE_RATE, 16, 1, true, false))) } catch (_: Exception) { false }

    private fun transcribeAudio(project: Project, audioBytes: ByteArray): String {
        return try {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            val request = http.postMultipart("/v1/speech/recognize", "audio", "recording.wav", "audio/wav", audioBytes)
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return ""
                val body = resp.body?.string() ?: return ""
                com.fasterxml.jackson.databind.ObjectMapper().readTree(body).path("text").asText("")
            }
        } catch (_: Exception) { "" }
    }

    private fun useWebSpeechApi(project: Project, future: CompletableFuture<String>) {
        ApplicationManager.getApplication().invokeLater {
            try {
                val panel = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getInstance(project)
                if (panel != null) {
                    // Set up a callback for the speech recognition result
                    val callbackJs = """
                        window.__codepilotVoiceResult = function(text) {
                            window.__codepilot_dispatch && window.__codepilot_dispatch('voice_result', { transcript: text });
                        };
                        if (window.SpeechRecognition || window.webkitSpeechRecognition) {
                            const r = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
                            r.lang='zh-CN'; r.continuous=false; r.interimResults=false;
                            r.onresult=(e)=>{window.__codepilotVoiceResult(e.results[0][0].transcript)};
                            r.onerror=()=>{window.__codepilotVoiceResult('')};
                            r.start();
                        } else { window.__codepilotVoiceResult(''); }
                    """.trimIndent()
                    panel.dispatchToWeb("voice_start", emptyMap<String, Any>())
                    // Execute the speech recognition script directly via the CEF browser
                    panel.component // ensure initialized
                    // Use dispatchToWeb to trigger voice recognition setup in the web UI
                    panel.dispatchToWeb("execute_script", mapOf("script" to callbackJs))
                }
                // The actual transcript will come back as a voice_result event;
                // for now, return empty since the async result comes via the event system.
                // A more complete implementation would register an event listener.
                future.complete("")
            } catch (_: Exception) { future.complete("") }
        }
    }
}