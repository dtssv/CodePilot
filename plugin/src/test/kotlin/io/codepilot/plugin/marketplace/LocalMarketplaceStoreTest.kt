package io.codepilot.plugin.marketplace

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

/**
 * Unit-level tests for LocalMarketplaceStore operations. Runs without IDE — validates disk
 * logic directly.
 */
class LocalMarketplaceStoreTest {
    @TempDir
    lateinit var tmp: Path

    @Test
    fun installAndList() {
        val store = createStore(tmp)
        val yaml =
            """
            id: skill.user.test
            version: 0.1.0
            source: user
            scope: global
            systemPrompt: |
              Test prompt
            """.trimIndent()
        store.installSkill(
            LocalMarketplaceStore.Scope.GLOBAL,
            null,
            "skill.user.test",
            "0.1.0",
            LocalMarketplaceStore.Source.BUILTIN_IDE,
            yaml,
        )
        val list = store.activeSkills(null)
        assertThat(list).hasSize(1)
        assertThat(list[0].entry.id).isEqualTo("skill.user.test")
    }

    @Test
    fun uninstallRemovesEntry() {
        val store = createStore(tmp)
        store.installSkill(
            LocalMarketplaceStore.Scope.GLOBAL,
            null,
            "skill.user.a",
            "1.0.0",
            LocalMarketplaceStore.Source.LOCAL,
            "systemPrompt: x",
        )
        assertThat(store.activeSkills(null)).hasSize(1)
        store.uninstallSkill(LocalMarketplaceStore.Scope.GLOBAL, null, "skill.user.a", "1.0.0")
        assertThat(store.activeSkills(null)).isEmpty()
    }

    /** Create a store that uses `root` as the global config root (avoids touching real OS dirs). */
    private fun createStore(root: Path): LocalMarketplaceStore {
        // We need a testable instance that overrides the OS root.
        // Since the class uses `osConfigRoot()` → can be bypassed by just setting env/system property.
        // For simplicity in this unit test, we directly construct and use the store's public API
        // by making a helper subclass — acceptable for a unit test, not for production code.
        return object : LocalMarketplaceStore() {
            override fun globalRoot(): Path = root.resolve("CodePilot")
        }
    }
}
