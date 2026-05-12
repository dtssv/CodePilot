package io.codepilot.plugin.tools

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.compiler.CompilerManager
import com.intellij.openapi.compiler.CompilationStatusListener
import com.intellij.openapi.compiler.CompileContext
import com.intellij.openapi.compiler.CompilerMessageCategory
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Async IDEA Build Validator — Non-blocking version of IdeaBuildValidator.
 *
 * Returns a CompletableFuture<BuildResult> instead of blocking,
 * allowing the caller to continue processing while the build runs.
 * Provides real-time progress callbacks for UI integration.
 */
object IdeaBuildAsyncValidator {

    data class BuildResult(
        val success: Boolean,
        val errors: List<IdeaBuildValidator.BuildError>,
        val warnings: List<IdeaBuildValidator.BuildMessage>,
        val durationMs: Long,
        val buildType: String,
    )

    data class BuildProgress(
        val phase: String, // "queuing" | "compiling" | "done"
        val filesCompleted: Int,
        val totalFiles: Int,
        val percentage: Double,
    )

    private val progressCallbacks = ConcurrentHashMap<String, (BuildProgress) -> Unit>()
    private const val BUILD_TIMEOUT_S = 120L

    /**
     * Run an async IDEA build with progress callbacks.
     * Returns a CompletableFuture that completes when the build finishes.
     */
    fun validateAsync(
        project: Project,
        filePaths: List<String> = emptyList(),
        onProgress: ((BuildProgress) -> Unit)? = null,
    ): CompletableFuture<BuildResult> {
        val cacheKey = "${project.basePath}:${filePaths.sorted().joinToString(",")}"
        onProgress?.let { progressCallbacks[cacheKey] = it }

        val startTime = System.currentTimeMillis()
        val future = CompletableFuture<BuildResult>()

        notifyProgress(cacheKey, BuildProgress("queuing", 0, 1, 0.0))

        ApplicationManager.getApplication().invokeLater {
            try {
                val compilerManager = CompilerManager.getInstance(project)

                val listener = object : CompilationStatusListener {
                    override fun compilationFinished(
                        aborted: Boolean, errors: Int, warnings: Int,
                        compileContext: CompileContext,
                    ) {
                        notifyProgress(cacheKey, BuildProgress("done", 1, 1, 100.0))

                        val buildErrors = mutableListOf<IdeaBuildValidator.BuildError>()
                        val buildWarnings = mutableListOf<IdeaBuildValidator.BuildMessage>()

                        for (category in CompilerMessageCategory.entries) {
                            for (msg in compileContext.getMessages(category)) {
                                val error = IdeaBuildValidator.BuildError(
                                    filePath = msg.virtualFile?.path ?: "",
                                    line = -1,
                                    column = -1,
                                    message = msg.message,
                                    severity = when (category) {
                                        CompilerMessageCategory.ERROR -> "ERROR"
                                        CompilerMessageCategory.WARNING -> "WARNING"
                                        else -> "INFO"
                                    },
                                )
                                if (error.severity == "ERROR") buildErrors.add(error)
                                else buildWarnings.add(IdeaBuildValidator.BuildMessage(error.filePath, error.line, error.message))
                            }
                        }

                        future.complete(BuildResult(
                            success = errors == 0 && !aborted,
                            errors = buildErrors, warnings = buildWarnings,
                            durationMs = System.currentTimeMillis() - startTime,
                            buildType = "idea-build-async",
                        ))
                        compilerManager.removeCompilationStatusListener(this)
                        progressCallbacks.remove(cacheKey)
                    }
                }

                compilerManager.addCompilationStatusListener(listener)
                notifyProgress(cacheKey, BuildProgress("compiling", 0, 1, 10.0))

                if (filePaths.isNotEmpty()) {
                    val virtualFiles = filePaths.mapNotNull { path ->
                        com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(path)
                    }.toTypedArray()
                    if (virtualFiles.isNotEmpty()) {
                        compilerManager.compile(virtualFiles) { _, _, _, _ -> }
                    } else {
                        future.complete(IdeaBuildValidator.validateWithIdeaBuild(project, filePaths).let {
                            BuildResult(it.success, it.errors, it.warnings, it.durationMs, it.buildType)
                        })
                    }
                } else {
                    compilerManager.make { _, _, _, _ -> }
                }
            } catch (e: Exception) {
                future.complete(IdeaBuildValidator.validateWithIdeaBuild(project, filePaths).let {
                    BuildResult(it.success, it.errors, it.warnings, it.durationMs, it.buildType)
                })
                progressCallbacks.remove(cacheKey)
            }
        }

        // Timeout fallback
        Thread({
            try {
                Thread.sleep(BUILD_TIMEOUT_S * 1000)
                if (!future.isDone) {
                    future.complete(BuildResult(false, emptyList(), emptyList(),
                        System.currentTimeMillis() - startTime, "timeout"))
                    progressCallbacks.remove(cacheKey)
                }
            } catch (_: InterruptedException) {}
        }, "codepilot-build-timeout").apply { isDaemon = true; start() }

        return future
    }

    private fun notifyProgress(cacheKey: String, progress: BuildProgress) {
        progressCallbacks[cacheKey]?.invoke(progress)
    }
}