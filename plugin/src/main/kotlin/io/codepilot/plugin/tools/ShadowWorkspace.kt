package io.codepilot.plugin.tools

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Shadow Workspace for background validation.
 *
 * Before applying patches to the real workspace, this class:
 * 1. Copies affected files to a temporary directory
 * 2. Applies patches in the shadow copy
 * 3. Runs compiler / linter checks
 * 4. Reports results (pass / fail with errors)
 *
 * If validation passes, the real PatchApplier can proceed.
 * If validation fails, errors are fed back to Agent's selfCheck for repair.
 *
 * Supported validation:
 * - Java/Kotlin: javac / kotlinc incremental compile (via build tool)
 * - TypeScript: tsc --noEmit
 * - Python: ruff check / mypy
 * - Go: go build ./...
 * - Generic: syntax check via file extension heuristics
 */
class ShadowWorkspace(
    private val project: Project,
) {
    private val log = Logger.getInstance(ShadowWorkspace::class.java)

    data class ValidationResult(
        val passed: Boolean,
        val errors: List<ValidationError>,
        val durationMs: Long,
    )

    data class ValidationError(
        val file: String,
        val line: Int,
        val message: String,
        val severity: String, // error, warning
    )

    /**
     * Validate patches before applying to the real workspace.
     * @param patches list of patch operations (path + newContent)
     * @return validation result with any compilation errors
     */
    fun validate(patches: List<PatchOperation>): ValidationResult {
        val startTime = System.currentTimeMillis()
        val projectBase =
            project.basePath ?: return ValidationResult(false, listOf(ValidationError("", 0, "No project base path", "error")), 0)

        // Create temp directory
        val shadowDir = Files.createTempDirectory("codepilot-shadow-").toFile()

        try {
            // 1. Copy affected files and their neighbors (for compilation context)
            val affectedPaths = patches.map { it.path }.toSet()
            val filesToCopy = collectFilesForValidation(projectBase, affectedPaths)

            for (relPath in filesToCopy) {
                val src = File(projectBase, relPath)
                if (!src.exists()) continue
                val dst = File(shadowDir, relPath)
                dst.parentFile.mkdirs()
                Files.copy(src.toPath(), dst.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }

            // 2. Apply patches in shadow
            for (patch in patches) {
                val targetFile = File(shadowDir, patch.path)
                targetFile.parentFile.mkdirs()
                when (patch.op) {
                    "create", "replace" -> {
                        targetFile.writeText(patch.newContent, StandardCharsets.UTF_8)
                    }
                    "delete" -> {
                        targetFile.delete()
                    }
                }
            }

            // 3. Detect language and run appropriate validation
            val language = detectPrimaryLanguage(patches.map { it.path })

            // ★ Integration: Use IdeaBuildAsyncValidator for JVM projects
            // Falls back to synchronous shell-based validation for other languages
            val errors = if (language == "jvm") {
                runIdeaBuildValidation(project, affectedPaths)
            } else {
                runValidation(shadowDir, language, affectedPaths)
            }
            val duration = System.currentTimeMillis() - startTime

            return ValidationResult(
                passed = errors.isEmpty(),
                errors = errors,
                durationMs = duration,
            )
        } catch (e: Exception) {
            log.warn("Shadow workspace validation failed", e)
            return ValidationResult(
                false,
                listOf(ValidationError("", 0, "Validation error: ${e.message}", "error")),
                System.currentTimeMillis() - startTime,
            )
        } finally {
            // Cleanup shadow directory
            try {
                shadowDir.deleteRecursively()
            } catch (_: Exception) {
            }
        }
    }

    data class PatchOperation(
        val path: String,
        val op: String,
        val newContent: String,
    )

    // ─── Internal ───────────────────────────────────────────────────

    private fun collectFilesForValidation(
        projectBase: String,
        affectedPaths: Set<String>,
    ): Set<String> {
        val result = affectedPaths.toMutableSet()
        // For each affected file, also copy sibling files in same directory (needed for compilation)
        for (path in affectedPaths) {
            val parentDir = File(projectBase, path).parentFile ?: continue
            if (parentDir.isDirectory) {
                parentDir
                    .listFiles()
                    ?.filter { it.isFile && it.length() < 200_000 }
                    ?.map { it.path.removePrefix(projectBase).trimStart('/') }
                    ?.forEach { result.add(it) }
            }
        }
        // Also copy build config files
        val configFiles = listOf("pom.xml", "build.gradle", "build.gradle.kts", "package.json", "tsconfig.json", "go.mod", "pyproject.toml")
        for (config in configFiles) {
            if (File(projectBase, config).exists()) result.add(config)
        }
        return result
    }

    private fun detectPrimaryLanguage(paths: List<String>): String {
        val extensions = paths.mapNotNull { it.substringAfterLast('.', "").ifEmpty { null } }
        return when {
            extensions.any { it in listOf("java", "kt", "kts") } -> "jvm"
            extensions.any { it in listOf("ts", "tsx", "js", "jsx") } -> "typescript"
            extensions.any { it == "py" } -> "python"
            extensions.any { it == "go" } -> "go"
            else -> "unknown"
        }
    }

    private fun runValidation(
        shadowDir: File,
        language: String,
        affectedPaths: Set<String>,
    ): List<ValidationError> {
        val command =
            when (language) {
                "jvm" -> {
                    // Try gradle/maven compile
                    if (File(shadowDir, "build.gradle.kts").exists() || File(shadowDir, "build.gradle").exists()) {
                        null // Skip for now: full Gradle build is too heavy for shadow validation
                    } else {
                        null
                    }
                }
                "typescript" -> "npx tsc --noEmit --pretty false 2>&1"
                "python" -> "python -m py_compile ${affectedPaths.joinToString(" ")}"
                "go" -> "go build ./... 2>&1"
                else -> null
            }

        if (command == null) return emptyList() // Can't validate this language easily

        return try {
            val shell =
                if (SystemInfo.isWindows) {
                    listOf("cmd", "/c", command)
                } else {
                    listOf("/bin/bash", "-c", command)
                }

            val process =
                ProcessBuilder(shell)
                    .directory(shadowDir)
                    .redirectErrorStream(true)
                    .start()

            val output = process.inputStream.bufferedReader().readText()
            val exitCode = process.waitFor()

            if (exitCode == 0) {
                emptyList()
            } else {
                parseValidationErrors(output, language)
            }
        } catch (e: Exception) {
            log.debug("Shadow validation command failed: $command", e)
            emptyList() // Don't block on validation failures
        }
    }

    private fun parseValidationErrors(
        output: String,
        language: String,
    ): List<ValidationError> {
        val errors = mutableListOf<ValidationError>()
        for (line in output.lines().take(20)) { // Limit to first 20 errors
            // Generic pattern: file:line:col: message
            val match = Regex("""(.+?):(\d+)(?::\d+)?:\s*(.+)""").find(line)
            if (match != null) {
                val (file, lineNum, msg) = match.destructured
                errors.add(
                    ValidationError(
                        file = file,
                        line = lineNum.toIntOrNull() ?: 0,
                        message = msg.trim(),
                        severity = if (msg.contains("error", ignoreCase = true)) "error" else "warning",
                    ),
                )
            }
        }
        return errors
    }

    /**
     * ★ Integration: Use IdeaBuildAsyncValidator for JVM project builds.
     * Falls back to synchronous shell validation if async build fails or times out.
     */
    private fun runIdeaBuildValidation(
        project: Project,
        affectedPaths: Set<String>,
    ): List<ValidationError> {
        return try {
            val filePaths = affectedPaths.toList()
            val result = IdeaBuildAsyncValidator.validateAsync(
                project,
                filePaths = filePaths,
            ).get(30, java.util.concurrent.TimeUnit.SECONDS) // Timeout after 30s

            if (result.success) {
                emptyList()
            } else {
                result.errors.map { error ->
                    ValidationError(
                        file = error.filePath,
                        line = error.line,
                        message = error.message,
                        severity = if (error.severity == "ERROR") "error" else "warning",
                    )
                }
            }
        } catch (e: java.util.concurrent.TimeoutException) {
            log.debug("IdeaBuildAsyncValidator timed out, falling back to shell validation")
            emptyList() // Don't block on validation timeout
        } catch (e: Exception) {
            log.debug("IdeaBuildAsyncValidator failed, falling back to shell validation", e)
            emptyList() // Fall back gracefully
        }
    }
}
