package io.codepilot.plugin.marketplace

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.settings.RegistryEntry

/**
 * WebUI ↔ plugin bridge for Skills marketplace (skill_list / install / uninstall / toggle).
 */
object SkillMarketplaceBridge {
    private val log = Logger.getInstance(SkillMarketplaceBridge::class.java)

    data class SkillListPage(
        val skills: List<Map<String, Any?>>,
        val page: Int,
        val pageSize: Int,
        val total: Int,
        val hasMore: Boolean,
    )

    fun listSkillsPage(
        project: Project?,
        payload: JsonNode,
    ): SkillListPage {
        val page = payload.path("page").asInt(1).coerceAtLeast(1)
        val pageSize = payload.path("pageSize").asInt(20).coerceIn(5, 100)
        val all = listSkills(project, payload)
        val total = all.size
        val start = (page - 1) * pageSize
        val slice = all.drop(start).take(pageSize)
        return SkillListPage(
            skills = slice,
            page = page,
            pageSize = pageSize,
            total = total,
            hasMore = start + slice.size < total,
        )
    }

    fun listSkills(
        project: Project?,
        payload: JsonNode,
    ): List<Map<String, Any?>> {
        val store = LocalMarketplaceStore.getInstance()
        val installed = store.listInstalledSkills(project)
        val installedById = LinkedHashMap<String, Pair<LocalMarketplaceStore.Scope, LocalMarketplaceStore.Entry>>()
        for ((scope, entry) in installed) {
            val existing = installedById[entry.id]
            if (existing == null || scope == LocalMarketplaceStore.Scope.PROJECT) {
                installedById[entry.id] = scope to entry
            }
        }

        val merged = LinkedHashMap<String, Map<String, Any?>>()
        for (reg in resolveRegistries(payload)) {
            try {
                ThirdPartyRegistryClient
                    .listPackages(reg.url)
                    .filter { it.type.equals("skill", ignoreCase = true) }
                    .forEach { pkg ->
                        val inst = installedById[pkg.slug]
                        merged.putIfAbsent(
                            pkg.slug,
                            toSkillEntry(pkg, inst),
                        )
                    }
            } catch (e: Exception) {
                log.warn("[Marketplace] list from ${reg.url}: ${e.message}")
            }
        }

        // Official marketplace (when reachable)
        try {
            MarketplaceClient()
                .listPackages(type = "skill", page = 1, size = 100)
                .get()
                .forEach { pkg ->
                    val inst = installedById[pkg.slug]
                    merged.putIfAbsent(
                        pkg.slug,
                        mapOf(
                            "id" to pkg.slug,
                            "name" to pkg.name,
                            "description" to (pkg.description ?: ""),
                            "version" to (pkg.latestVersion ?: "0.0.0"),
                            "author" to (pkg.author ?: "CodePilot"),
                            "category" to "utility",
                            "scope" to (inst?.first?.value ?: "global"),
                            "installed" to (inst != null),
                            "enabled" to (inst?.second?.disabled != true),
                        ),
                    )
                }
        } catch (e: Exception) {
            log.debug("[Marketplace] official catalog: ${e.message}")
        }

        for ((scope, entry) in installed) {
            if (merged.containsKey(entry.id)) continue
            merged[entry.id] =
                mapOf(
                    "id" to entry.id,
                    "name" to entry.id,
                    "description" to "Installed locally (${entry.source})",
                    "version" to entry.version,
                    "author" to "local",
                    "category" to "utility",
                    "scope" to scope.value,
                    "installed" to true,
                    "enabled" to !entry.disabled,
                )
        }
        return merged.values.toList()
    }

    fun install(
        project: Project,
        payload: JsonNode,
    ): String? {
        val id = payload.path("id").asText("").trim().ifBlank { return "Missing skill id" }
        val version = payload.path("version").asText("").trim().ifBlank { null }
        val scope =
            if (payload.path("scope").asText("global") == "project") {
                LocalMarketplaceStore.Scope.PROJECT
            } else {
                LocalMarketplaceStore.Scope.GLOBAL
            }
        val registryUrl = payload.path("registryUrl").asText(null)?.trim()?.ifBlank { null }

        if (registryUrl != null) {
            val ver = version ?: resolveVersion(registryUrl, id) ?: return "Could not resolve version"
            val result =
                RegistryE2EVerifier
                    .installFromRegistry(project, registryUrl, id, ver)
                    .get()
            return if (result.success) null else result.message
        }

        val registries = resolveRegistries(payload)
        for (reg in registries) {
            val pkg =
                ThirdPartyRegistryClient.listPackages(reg.url).firstOrNull {
                    it.slug == id && it.type.equals("skill", ignoreCase = true)
                } ?: continue
            val ver = version ?: pkg.version
            val result =
                RegistryE2EVerifier
                    .installFromRegistry(project, reg.url, id, ver)
                    .get()
            return if (result.success) null else result.message
        }

        val ver = version ?: resolveOfficialVersion(id) ?: return "Could not resolve version for $id"
        val installer = PackageInstaller(project = project)
        val result = installer.install(id, ver, scope)
        return if (result.success) null else (result.error ?: "Install failed")
    }

    fun uninstall(
        project: Project?,
        payload: JsonNode,
    ): Boolean {
        val id = payload.path("id").asText("").trim().ifBlank { return false }
        val version = payload.path("version").asText("").trim().ifBlank { null }
        val store = LocalMarketplaceStore.getInstance()
        var removed = false
        for ((scope, entry) in store.listInstalledSkills(project)) {
            if (entry.id != id) continue
            if (version != null && entry.version != version) continue
            removed =
                store.uninstallSkill(scope, project.takeIf { scope == LocalMarketplaceStore.Scope.PROJECT }, id, entry.version) ||
                    removed
            if (version != null) break
        }
        return removed
    }

    fun toggle(
        project: Project?,
        payload: JsonNode,
    ): Boolean {
        val id = payload.path("id").asText("").trim().ifBlank { return false }
        val enabled = payload.path("enabled").asBoolean(true)
        val version = payload.path("version").asText("").trim().ifBlank { null }
        val store = LocalMarketplaceStore.getInstance()
        var updated = false
        for ((scope, entry) in store.listInstalledSkills(project)) {
            if (entry.id != id) continue
            if (version != null && entry.version != version) continue
            store.setSkillEnabled(scope, project.takeIf { scope == LocalMarketplaceStore.Scope.PROJECT }, id, entry.version, enabled)
            updated = true
            if (version != null) break
        }
        return updated
    }

    private fun resolveRegistries(payload: JsonNode): List<RegistryEntry> {
        val seen = LinkedHashSet<String>()
        val out = mutableListOf<RegistryEntry>()
        fun add(name: String, url: String) {
            val normalized = url.trim().trimEnd('/')
            if (normalized.isBlank() || !seen.add(normalized)) return
            out.add(RegistryEntry(name.ifBlank { normalized }, normalized, ""))
        }
        CodePilotSettings.getInstance().state.registries.forEach { add(it.name, it.url) }
        val regNode = payload.path("registries")
        if (regNode.isArray) {
            regNode.forEach { node ->
                add(node.path("name").asText(""), node.path("url").asText(""))
            }
        }
        return out
    }

    private fun toSkillEntry(
        pkg: ThirdPartyRegistryClient.PackageSummary,
        installed: Pair<LocalMarketplaceStore.Scope, LocalMarketplaceStore.Entry>?,
    ): Map<String, Any?> =
        mapOf(
            "id" to pkg.slug,
            "name" to pkg.title,
            "description" to (pkg.description ?: ""),
            "version" to pkg.version,
            "author" to (pkg.author ?: "Unknown"),
            "category" to categoryFromTags(pkg.tags),
            "scope" to (installed?.first?.value ?: "global"),
            "installed" to (installed != null),
            "enabled" to (installed?.second?.disabled != true),
        )

    private fun categoryFromTags(tags: List<String>?): String {
        val normalized = tags?.map { it.lowercase() }.orEmpty()
        return when {
            normalized.any { it in setOf("language", "lang") } -> "language"
            normalized.any { it == "framework" } -> "framework"
            normalized.any { it == "action" } -> "action"
            else -> "utility"
        }
    }

    private fun resolveVersion(registryUrl: String, slug: String): String? =
        ThirdPartyRegistryClient.getPackageDetail(registryUrl, slug)?.version
            ?: ThirdPartyRegistryClient.listPackages(registryUrl).firstOrNull { it.slug == slug }?.version

    private fun resolveOfficialVersion(slug: String): String? =
        try {
            MarketplaceClient().listPackages(type = "skill", page = 1, size = 200).get().firstOrNull { it.slug == slug }?.latestVersion
        } catch (_: Exception) {
            null
        }

    fun runAsync(
        project: Project?,
        block: () -> Unit,
        onUi: () -> Unit,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                block()
            } catch (e: Exception) {
                log.warn("[Marketplace] ${e.message}")
            } finally {
                ApplicationManager.getApplication().invokeLater {
                    if (project == null || !project.isDisposed) onUi()
                }
            }
        }
    }
}
