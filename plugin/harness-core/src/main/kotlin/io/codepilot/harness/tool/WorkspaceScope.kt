package io.codepilot.harness.tool

import java.nio.file.Path
import kotlin.io.path.absolutePathString
import kotlin.io.path.exists

class WorkspaceScope(val root: Path) {
    init {
        require(root.exists()) { "workspace root does not exist: $root" }
    }

    fun resolve(relOrAbs: String): Path? {
        val p = Path.of(relOrAbs)
        val abs = if (p.isAbsolute) p else root.resolve(p)
        val normalized = abs.normalize().absolutePathString()
        val rootStr = root.normalize().absolutePathString()
        return if (normalized == rootStr || normalized.startsWith(rootStr + System.getProperty("file.separator"))) {
            Path.of(normalized)
        } else null
    }
}
