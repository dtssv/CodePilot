package io.codepilot.plugin.marketplace

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.HexFormat
import java.util.concurrent.ConcurrentHashMap

/**
 * On-disk catalog of installed user Skills / MCPs.
 *
 *  - **project scope** — under `<projectRoot>/.codePilot/{skills,mcps}/installed/`
 *  - **global scope**  — under the platform-conventional config directory
 *      (macOS: `~/Library/Application Support/CodePilot/...`, Linux: `~/.config/codePilot/...`,
 *      Windows: `%APPDATA%\CodePilot\...`).
 *
 * Each Skill is one directory `<id>@<version>/skill.yaml`. A small `index.json` tracks installed
 * IDs so we don't have to scan the directory every request.
 */
@Service(Service.Level.APP)
open class LocalMarketplaceStore {

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val cache = ConcurrentHashMap<String, IndexFile>()

    open fun globalRoot(): Path = osConfigRoot().resolve("CodePilot")

    fun projectRoot(project: Project): Path =
        Path.of(project.basePath ?: error("no project base path"), ".codePilot")

    /** Returns the matching root for a given scope. */
    fun root(scope: Scope, project: Project?): Path =
        when (scope) {
            Scope.PROJECT -> projectRoot(project ?: error("project required for project-scoped install"))
            Scope.GLOBAL -> globalRoot()
        }

    /** Install a Skill payload on disk and update the index. */
    fun installSkill(
        scope: Scope,
        project: Project?,
        slug: String,
        version: String,
        source: Source,
        yaml: String,
    ): Path {
        val skillDir = root(scope, project).resolve("skills/installed/$slug@$version")
        Files.createDirectories(skillDir)
        val target = skillDir.resolve("skill.yaml")
        Files.writeString(target, yaml, StandardCharsets.UTF_8)
        val index = readIndex(skillsIndex(scope, project))
        index.skills.removeAll { it.id == slug && it.version == version }
        index.skills.add(
            Entry(
                id = slug,
                version = version,
                scope = scope.value,
                source = source.value,
                sha256 = sha256(yaml),
                installedAt = java.time.Instant.now().toString(),
                disabled = false,
            ),
        )
        writeIndex(skillsIndex(scope, project), index)
        return target
    }

    fun uninstallSkill(scope: Scope, project: Project?, slug: String, version: String): Boolean {
        val skillDir = root(scope, project).resolve("skills/installed/$slug@$version")
        val removed = if (Files.exists(skillDir)) {
            deleteRecursively(skillDir); true
        } else false
        val index = readIndex(skillsIndex(scope, project))
        val before = index.skills.size
        index.skills.removeAll { it.id == slug && it.version == version }
        writeIndex(skillsIndex(scope, project), index)
        return removed || (index.skills.size < before)
    }

    fun setSkillEnabled(scope: Scope, project: Project?, slug: String, version: String, enabled: Boolean) {
        val index = readIndex(skillsIndex(scope, project))
        val updated = index.skills.map {
            if (it.id == slug && it.version == version) it.copy(disabled = !enabled) else it
        }.toMutableList()
        writeIndex(skillsIndex(scope, project), index.copy(skills = updated))
    }

    /** Lists active (non-disabled) Skills across both scopes; project takes precedence. */
    fun activeSkills(project: Project?): List<ActiveSkill> {
        val merged = LinkedHashMap<String, ActiveSkill>()
        if (project != null) {
            readIndex(skillsIndex(Scope.PROJECT, project)).skills
                .filter { !it.disabled }
                .forEach { merged[it.id] = ActiveSkill(it, "project", projectRoot(project).resolve("skills/installed/${it.id}@${it.version}/skill.yaml")) }
        }
        readIndex(skillsIndex(Scope.GLOBAL, null)).skills
            .filter { !it.disabled }
            .forEach { entry ->
                merged.putIfAbsent(
                    entry.id,
                    ActiveSkill(entry, "global", globalRoot().resolve("skills/installed/${entry.id}@${entry.version}/skill.yaml")),
                )
            }
        return merged.values.toList()
    }

    fun readSkillBody(handle: ActiveSkill): String =
        Files.readString(handle.path, StandardCharsets.UTF_8)

    private fun skillsIndex(scope: Scope, project: Project?): Path =
        root(scope, project).resolve("skills/index.json")

    private fun readIndex(file: Path): IndexFile {
        val key = file.toAbsolutePath().toString()
        cache[key]?.let { return it.copy() }
        if (!Files.exists(file)) return IndexFile(mutableListOf()).also { cache[key] = it }
        val parsed: IndexFile = mapper.readValue(Files.readAllBytes(file))
        cache[key] = parsed
        return parsed.copy()
    }

    private fun writeIndex(file: Path, index: IndexFile) {
        Files.createDirectories(file.parent)
        Files.writeString(file, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(index))
        cache[file.toAbsolutePath().toString()] = index
    }

    private fun sha256(text: String): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(StandardCharsets.UTF_8)))

    private fun deleteRecursively(path: Path) {
        if (!Files.exists(path)) return
        Files.walk(path).use { stream ->
            stream.sorted(Comparator.reverseOrder()).forEach(Files::delete)
        }
    }

    private fun osConfigRoot(): Path {
        val home = Path.of(System.getProperty("user.home"))
        return when {
            SystemInfo.isMac -> home.resolve("Library/Application Support")
            SystemInfo.isWindows -> Path.of(System.getenv("APPDATA") ?: home.toString())
            else -> {
                // XDG Base Dir
                val xdg = System.getenv("XDG_CONFIG_HOME")
                if (xdg.isNullOrBlank()) home.resolve(".config") else Path.of(xdg)
            }
        }
    }

    enum class Scope(val value: String) { PROJECT("project"), GLOBAL("global") }

    enum class Source(val value: String) {
        OFFICIAL("official"),
        THIRD_PARTY("third-party"),
        LOCAL("local"),
        BUILTIN_IDE("builtin-ide"),
    }

    data class Entry(
        val id: String,
        val version: String,
        val scope: String,
        val source: String,
        val sha256: String,
        val installedAt: String,
        val disabled: Boolean = false,
    )

    data class IndexFile(val skills: MutableList<Entry> = mutableListOf(), val mcps: MutableList<McpEntry> = mutableListOf())

    data class ActiveSkill(val entry: Entry, val scope: String, val path: Path)

    /** Represents an installed MCP server. */
    data class McpEntry(
        val id: String,
        val version: String = "1.0.0",
        val argv: List<String>,
        val cwd: String? = null,
        val env: Map<String, String> = emptyMap(),
        val installedAt: String = "",
        val disabled: Boolean = false,
    )

    /** Returns all installed and enabled MCP servers (from global scope). */
    fun installedMcpServers(): List<McpEntry> {
        val index = readIndex(mcpIndex())
        return index.mcps.filter { !it.disabled }
    }

    /** Install an MCP server entry. */
    fun installMcp(entry: McpEntry) {
        val index = readIndex(mcpIndex())
        index.mcps.removeAll { it.id == entry.id }
        index.mcps.add(entry)
        writeIndex(mcpIndex(), index)
    }

    /** Uninstall an MCP server. */
    fun uninstallMcp(id: String): Boolean {
        val index = readIndex(mcpIndex())
        val before = index.mcps.size
        index.mcps.removeAll { it.id == id }
        writeIndex(mcpIndex(), index)
        return index.mcps.size < before
    }

    private fun mcpIndex(): Path = globalRoot().resolve("mcps/index.json")

    /** Record a skill install in the index (alias for installSkill that also records manifest). */
    fun recordInstall(slug: String, version: String, scope: Scope, source: Source, manifest: Map<String, Any?>) {
        val yaml = manifest["yaml"] as? String ?: ""
        installSkill(scope, null, slug, version, source, yaml)
    }

    /** Reload the index from disk (clears cache). */
    fun reloadIndex() {
        cache.clear()
    }

    /** Check if a skill is installed by its slug. */
    fun isInstalled(slug: String): Boolean {
        val globalIndex = readIndex(skillsIndex(Scope.GLOBAL, null))
        return globalIndex.skills.any { it.id == slug }
    }

    /** Get the install directory for a skill. */
    fun getInstallDir(slug: String, version: String, scope: Scope): Path {
        return root(scope, null).resolve("skills/installed/$slug@$version")
    }

    companion object {
        @JvmStatic fun getInstance(): LocalMarketplaceStore = service()
    }
}