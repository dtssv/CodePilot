package io.codepilot.harness.skill

import java.util.Locale

/**
 * Lightweight inference of language / framework / action signals from a turn.
 *
 * Sunk from backend/codePilot-core/.../skill/WorkspaceProbe.java. The original
 * is a Spring `@Component` that inspects `ConversationRunRequest` (a backend
 * DTO with contexts/refs, pinned items, taskLedger.notes). This version is a
 * plain data class that the IDE adapter populates directly from the open
 * editor + workspace files + the user's current message — no ConversationRunRequest.
 *
 * Inferred signals:
 *   - languages:     from file extensions in [filePaths] (java, kotlin, python, ...)
 *   - frameworks:     from build files (pom.xml, package.json, go.mod) + keyword mining
 *   - keywords:       from the [userInput] (refactor, review, test, doc, comment)
 *   - action:         first [bracketed] token of [userInput], or "generic"
 */
data class WorkspaceProbe(
    val mode: String = "AGENT",                // "AGENT" | "CHAT"
    val action: String = "generic",
    val languages: Set<String> = emptySet(),
    val frameworks: Set<String> = emptySet(),
    val filePaths: Set<String> = emptySet(),
    val keywords: Set<String> = emptySet(),
) {
    companion object {
        /**
         * Build a probe from the current turn's signals. The IDE adapter
         * supplies [filePaths] (open files + referenced files) and [userInput]
         * (the user's latest message).
         */
        fun build(
            mode: String = "AGENT",
            filePaths: Set<String> = emptySet(),
            userInput: String = "",
        ): WorkspaceProbe {
            val langs = linkedSetOf<String>()
            val frameworks = linkedSetOf<String>()
            val keywords = linkedSetOf<String>()

            for (path in filePaths) addLanguageFromPath(path, langs, frameworks)
            mineNote(userInput, langs, frameworks, keywords)

            val action = detectAction(userInput)
            return WorkspaceProbe(
                mode = if (mode.isBlank()) "CHAT" else mode,
                action = action,
                languages = langs.toSet(),
                frameworks = frameworks.toSet(),
                filePaths = filePaths,
                keywords = keywords.toSet(),
            )
        }

        private fun addLanguageFromPath(path: String, languages: MutableSet<String>, frameworks: MutableSet<String>) {
            val lower = path.lowercase(Locale.ROOT)
            when {
                lower.endsWith(".java") -> languages.add("java")
                lower.endsWith(".kt") || lower.endsWith(".kts") -> languages.add("kotlin")
                lower.endsWith(".scala") || lower.endsWith(".sbt") -> languages.add("scala")
                lower.endsWith(".py") || lower.endsWith(".pyi") -> languages.add("python")
                lower.endsWith(".go") -> languages.add("go")
                lower.endsWith(".rs") -> languages.add("rust")
                lower.endsWith(".ts") || lower.endsWith(".tsx") -> languages.add("typescript")
                lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs") -> languages.add("javascript")
                lower.endsWith(".vue") -> languages.add("vue")
                lower.endsWith(".rb") -> languages.add("ruby")
                lower.endsWith(".php") -> languages.add("php")
                lower.endsWith(".cs") -> languages.add("csharp")
                lower.endsWith(".sql") -> languages.add("sql")
                lower.endsWith(".sh") || lower.endsWith(".bash") -> languages.add("shell")
                lower.endsWith(".ps1") -> languages.add("powershell")
            }
            when {
                lower.endsWith("pom.xml") || lower.endsWith("build.gradle") || lower.endsWith("build.gradle.kts") -> {
                    languages.add("java"); frameworks.add("gradle-or-maven")
                }
                lower.endsWith("package.json") || lower.endsWith("tsconfig.json") -> frameworks.add("node")
                lower.endsWith("pyproject.toml") || lower.endsWith("requirements.txt") -> frameworks.add("python")
                lower.endsWith("go.mod") -> frameworks.add("go-modules")
                lower.endsWith("cargo.toml") -> frameworks.add("cargo")
                lower.endsWith("dockerfile") -> frameworks.add("docker")
            }
        }

        private fun mineNote(note: String, languages: MutableSet<String>, frameworks: MutableSet<String>, keywords: MutableSet<String>) {
            val s = note.lowercase(Locale.ROOT)
            when {
                s.contains("spring boot") || s.contains("springboot") -> frameworks.add("spring-boot")
            }
            if (s.contains("mybatis")) frameworks.add("mybatis")
            if (s.contains("react")) frameworks.add("react")
            if (s.contains("nextjs") || s.contains("next.js")) frameworks.add("nextjs")
            if (s.contains("vue")) { frameworks.add("vue"); languages.add("vue") }
            if (s.contains("django")) frameworks.add("django")
            if (s.contains("fastapi")) frameworks.add("fastapi")
            if (s.contains("postgres") || s.contains("pgvector")) frameworks.add("postgres")
            if (s.contains("mysql")) frameworks.add("mysql")
            if (s.contains("redis")) frameworks.add("redis")
            if (s.contains("kubernetes") || s.contains("k8s")) frameworks.add("kubernetes")
            if (s.contains("docker")) frameworks.add("docker")
            if (s.contains("refactor")) keywords.add("refactor")
            if (s.contains("review")) keywords.add("review")
            if (s.contains("test") || s.contains("unittest")) keywords.add("gentest")
            if (s.contains("doc") || s.contains("documentation")) keywords.add("gendoc")
            if (s.contains("comment") || s.contains("注释")) keywords.add("comment")
        }

        private fun detectAction(input: String): String {
            val header = input.lines().firstOrNull() ?: ""
            val b = header.indexOf('[')
            val e = header.indexOf(']')
            return if (b == 0 && e > 1) header.substring(1, e).lowercase(Locale.ROOT) else "generic"
        }
    }
}
