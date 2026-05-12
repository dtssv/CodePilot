package io.codepilot.plugin.tools

import com.intellij.compiler.server.BuildManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.compiler.CompilerManager
import com.intellij.openapi.compiler.CompilationStatusListener
import com.intellij.openapi.compiler.CompilerMessageCategory
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

/**
 * IDEA Build Validator — Integrates Shadow Workspace validation with IDEA's
 * actual Java/Kotlin compiler for real compilation error detection.
 *
 * This replaces the simple "local compilation check" in ShadowWorkspace with
 * IDEA's full build system, which provides:
 * - Accurate Java/Kotlin compilation errors
 * - Annotation processor validation
 * - Resource file validation
 * - Multi-module dependency resolution
 *
 * Usage: Called from ShadowWorkspace.validate() as the primary validation step.
 * Falls back to text-based heuristic analysis if IDEA build is unavailable.
 */
object IdeaBuildValidator {

    data class BuildResult(
        val success: Boolean,
        val errors: List<BuildError>,
        val warnings: List<BuildMessage>,
        val durationMs: Long,
        val buildType: String, // "idea-build" | "heuristic"
    )

    data class BuildError(
        val filePath: String,
        val line: Int,
        val column: Int,
        val message: String,
        val severity: String, // "ERROR" | "WARNING" | "INFO"
    )

    data class BuildMessage(
        val filePath: String?,
        val line: Int,
        val message: String,
    )

    // Cache recent build results per project
    private val buildCache = ConcurrentHashMap<String, BuildResult>()
    private const val BUILD_CACHE_TTL_MS = 30_000L // 30s cache for same project
    private const val BUILD_TIMEOUT_S = 60L

    /**
     * Run an IDEA incremental build and return compilation errors.
     * This triggers IDEA's actual compiler (javac + kotlinc) on the project.
     *
     * @param project The IDEA project
     * @param filePaths Optional specific files to validate (for incremental validation)
     * @return BuildResult with any compilation errors found
     */
    fun validateWithIdeaBuild(
        project: Project,
        filePaths: List<String> = emptyList(),
    ): BuildResult {
        val cacheKey = "${project.basePath}:${filePaths.sorted().joinToString(",")}"
        val now = System.currentTimeMillis()

        // Check cache
        buildCache[cacheKey]?.let { cached ->
            if (now - cached.durationMs < BUILD_CACHE_TTL_MS) return cached
        }

        val startTime = System.currentTimeMillis()
        val future = CompletableFuture<BuildResult>()

        ApplicationManager.getApplication().invokeLater {
            try {
                val compilerManager = CompilerManager.getInstance(project)

                // Register a compilation status listener to capture results
                val listener = object : CompilationStatusListener {
                    override fun compilationFinished(
                        aborted: Boolean,
                        errors: Int,
                        warnings: Int,
                        compileContext: com.intellij.openapi.compiler.CompileContext,
                    ) {
                        val buildErrors = mutableListOf<BuildError>()
                        val buildWarnings = mutableListOf<BuildMessage>()

                        // Extract errors from compile context
                        for (category in CompilerMessageCategory.entries) {
                            for (msg in compileContext.getMessages(category)) {
                                val error = BuildError(
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
                                if (error.severity == "ERROR") {
                                    buildErrors.add(error)
                                } else {
                                    buildWarnings.add(BuildMessage(error.filePath, error.line, error.message))
                                }
                            }
                        }

                        val result = BuildResult(
                            success = errors == 0 && !aborted,
                            errors = buildErrors,
                            warnings = buildWarnings,
                            durationMs = System.currentTimeMillis() - startTime,
                            buildType = "idea-build",
                        )
                        future.complete(result)
                    }
                }

                compilerManager.addCompilationStatusListener(listener)

                // Trigger incremental build
                if (filePaths.isNotEmpty()) {
                    // Build specific files (incremental)
                    val virtualFiles = filePaths.mapNotNull { path ->
                        com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(path)
                    }.toTypedArray()

                    if (virtualFiles.isNotEmpty()) {
                        compilerManager.compile(virtualFiles) { aborted, errors, warnings, context ->
                            // Will be handled by the listener above
                        }
                    } else {
                        // Files not found in VFS, fall back to heuristic
                        future.complete(heuristicValidation(project, filePaths))
                    }
                } else {
                    // Full project build
                    compilerManager.make { aborted, errors, warnings, context ->
                        // Will be handled by the listener above
                    }
                }

                // Remove listener after completion
                future.whenComplete { _, _ ->
                    compilerManager.removeCompilationStatusListener(listener)
                }
            } catch (e: Exception) {
                // Fallback to heuristic validation
                future.complete(heuristicValidation(project, filePaths))
            }
        }

        // Wait for build with timeout
        return try {
            val result = future.get(BUILD_TIMEOUT_S, TimeUnit.SECONDS)
            buildCache[cacheKey] = result
            result
        } catch (_: Exception) {
            heuristicValidation(project, filePaths)
        }
    }

    /**
     * Heuristic-based validation as fallback when IDEA build is unavailable.
     * Performs basic syntax checks on the provided file paths.
     */
    private fun heuristicValidation(project: Project, filePaths: List<String>): BuildResult {
        val startTime = System.currentTimeMillis()
        val errors = mutableListOf<BuildError>()
        val warnings = mutableListOf<BuildMessage>()

        for (path in filePaths) {
            try {
                val vFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(path)
                if (vFile == null) continue
                val content = String(vFile.contentsToByteArray())

                // Basic checks
                val openBraces = content.count { it == '{' }
                val closeBraces = content.count { it == '}' }
                if (openBraces != closeBraces) {
                    errors.add(BuildError(
                        filePath = path,
                        line = 1,
                        column = 1,
                        message = "Unbalanced braces: $openBraces open, $closeBraces close",
                        severity = "ERROR",
                    ))
                }

                val openParens = content.count { it == '(' }
                val closeParens = content.count { it == ')' }
                if (openParens != closeParens) {
                    errors.add(BuildError(
                        filePath = path,
                        line = 1,
                        column = 1,
                        message = "Unbalanced parentheses: $openParens open, $closeParens close",
                        severity = "ERROR",
                    ))
                }

                // Check for common syntax errors
                val lines = content.lines()
                for ((idx, line) in lines.withIndex()) {
                    val trimmed = line.trim()
                    if (trimmed.startsWith("import ") && !trimmed.endsWith(";") && !trimmed.contains(".*")) {
                        warnings.add(BuildMessage(path, idx + 1, "Import statement may be missing semicolon"))
                    }
                }
            } catch (_: Exception) { continue }
        }

        return BuildResult(
            success = errors.isEmpty(),
            errors = errors,
            warnings = warnings,
            durationMs = System.currentTimeMillis() - startTime,
            buildType = "heuristic",
        )
    }

    /**
     * Quick check if IDEA build system is available for the project.
     */
    fun isIdeaBuildAvailable(project: Project): Boolean {
        return try {
            CompilerManager.getInstance(project) != null
        } catch (_: Exception) { false }
    }
}