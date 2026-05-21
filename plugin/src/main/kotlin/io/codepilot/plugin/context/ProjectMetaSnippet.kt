package io.codepilot.plugin.context

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem

/**
 * Compact project root scan for LLM context (build system + language hints).
 * Shared by chat submission and one-click actions.
 */
fun buildProjectMetaSnippet(project: Project): String {
    val base = project.basePath ?: return ""
    val root =
        LocalFileSystem.getInstance().refreshAndFindFileByPath(base)
            ?: return ""

    val extensions = mutableSetOf<String>()
    val rootEntries = mutableListOf<String>()
    for (child in root.children.take(200)) {
        val entry = if (child.isDirectory) "${child.name}/" else child.name
        rootEntries.add(entry)
        if (!child.isDirectory) {
            val ext = child.extension?.lowercase()
            if (ext != null) extensions.add(ext)
        }
    }

    for (child in root.children.take(50)) {
        if (child.isDirectory) {
            for (subChild in child.children.take(30)) {
                if (!subChild.isDirectory) {
                    val ext = subChild.extension?.lowercase()
                    if (ext != null) extensions.add(ext)
                }
            }
        }
    }

    val languages = mutableSetOf<String>()
    for (ext in extensions) {
        when (ext) {
            "java", "kt", "kts" -> languages.add(if (ext == "java") "Java" else "Kotlin")
            "cpp", "cc", "cxx", "c", "h", "hpp", "hxx" -> languages.add("C/C++")
            "py" -> languages.add("Python")
            "js", "mjs", "cjs" -> languages.add("JavaScript")
            "ts", "tsx" -> languages.add("TypeScript")
            "go" -> languages.add("Go")
            "rs" -> languages.add("Rust")
            "rb" -> languages.add("Ruby")
            "swift" -> languages.add("Swift")
            "scala" -> languages.add("Scala")
            "xml", "gradle", "properties" -> languages.add("Build Config")
        }
    }

    val names = rootEntries.map { it.trimEnd('/') }
    val hasCMake = names.any { it.equals("CMakeLists.txt", ignoreCase = true) }
    val hasMakefile = names.any { it.equals("Makefile", ignoreCase = true) }
    val hasPom = names.any { it.equals("pom.xml", ignoreCase = true) }
    val hasGradle = names.any { it.startsWith("build.gradle") }
    val hasPackageJson = names.any { it.equals("package.json", ignoreCase = true) }
    val cppSources = names.count { it.endsWith(".cpp") || it.endsWith(".cc") || it.endsWith(".cxx") }

    return buildString {
        if (languages.isNotEmpty()) {
            appendLine("Project languages: ${languages.joinToString(", ")}")
        }
        appendLine("Build system hints (pick commands that match user compile/run intent):")
        when {
            hasCMake -> {
                appendLine("  - CMake detected (CMakeLists.txt).")
                appendLine(
                    "    Typical path for compile+run: read CMakeLists.txt if needed → cmake --build build -j → run ./build/<target>",
                )
                appendLine(
                    "    fs.list/fs.read on build/, target/, out/, dist/ etc. are allowed (build outputs)",
                )
            }

            hasMakefile -> appendLine("  - Makefile detected. Prefer: make -j (read Makefile targets first)")
            hasPom -> appendLine("  - Maven detected (pom.xml). Prefer: mvn -q compile / mvn -q exec:java …")
            hasGradle -> appendLine("  - Gradle detected. Prefer: ./gradlew build or tasks from build.gradle")
            hasPackageJson ->
                appendLine("  - Node/npm detected. Prefer: npm run build / npm test per package.json scripts")

            cppSources > 0 && !hasCMake && !hasMakefile ->
                appendLine(
                    "  - Bare C++ sources ($cppSources .cpp at root). Prefer: g++ -std=c++17 -O0 -o app main.cpp [others…] then ./app",
                )

            else -> appendLine("  - Unknown — run fs.list/fs.read before choosing compile commands")
        }
        appendLine("Root directory entries (${rootEntries.size}):")
        for (entry in rootEntries.take(50)) {
            appendLine("  $entry")
        }
    }
}
