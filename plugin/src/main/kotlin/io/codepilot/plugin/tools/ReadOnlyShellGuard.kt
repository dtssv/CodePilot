package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode

/**
 * Validates that a shell command is read-only before execution by the Gather node.
 * Only whitelisted command prefixes are allowed when `readOnly=true`.
 *
 * This guard is checked BEFORE dispatching to [ShellExecutor]. If the command fails
 * validation, a [ToolViolation] is thrown and the Gather node records it as
 * `gather_write_blocked`.
 */
object ReadOnlyShellGuard {
    /** Whitelisted read-only command prefixes. */
    private val ALLOWED_PREFIXES =
        listOf(
            "git log",
            "git diff",
            "git status",
            "git show",
            "git branch",
            "git tag",
            "git rev-parse",
            "git describe",
            "git ls-files",
            "git blame",
            "ls",
            "cat",
            "head",
            "tail",
            "wc",
            "grep",
            "find",
            "which",
            "whereis",
            "file",
            "stat",
            "du",
            "df",
            "pwd",
            "echo",
            "printf",
            "env",
            "printenv",
            "uname",
            "hostname",
            "date",
            "id",
            "whoami",
            "node -v",
            "node --version",
            "npm -v",
            "npm --version",
            "npm ls",
            "npx --version",
            "yarn --version",
            "pnpm --version",
            "java -version",
            "java --version",
            "javac -version",
            "mvn -v",
            "mvn --version",
            "mvn dependency:tree",
            "mvn help:effective-pom",
            "gradle -v",
            "gradle --version",
            "gradle dependencies",
            "python --version",
            "python3 --version",
            "pip list",
            "pip show",
            "go version",
            "go list",
            "go env",
            "rustc --version",
            "cargo --version",
            "docker ps",
            "docker images",
            "docker version",
            "kubectl get",
            "kubectl describe",
            "kubectl version",
        )

    /** Dangerous patterns that must never be allowed even if prefix matches. */
    private val DENY_PATTERNS =
        listOf(
            Regex("""[;&|]"""), // chaining or piping to mutating cmd
            Regex("""\$\("""), // command substitution
            Regex("""`[^`]+`"""), // backtick substitution
            Regex(""">"""), // output redirect (write)
            Regex("""rm\s"""),
            Regex("""sudo\s"""),
            Regex("""chmod\s"""),
            Regex("""chown\s"""),
            Regex("""mv\s"""),
            Regex("""cp\s"""),
            Regex("""kill\s"""),
        )

    /**
     * Validates the command. Throws [ToolViolation] if not allowed.
     */
    fun validate(args: JsonNode) {
        val cmd = args.path("cmd").asText(args.path("command").asText("")).trim()
        if (cmd.isBlank()) throw ToolViolation("empty read-only shell command")

        // Check deny patterns first
        DENY_PATTERNS.forEach { p ->
            if (p.containsMatchIn(cmd)) throw ToolViolation("read-only shell: denied pattern '${p.pattern}' in: $cmd")
        }

        // Check whitelist
        val allowed = ALLOWED_PREFIXES.any { prefix -> cmd.startsWith(prefix, ignoreCase = true) }
        if (!allowed) throw ToolViolation("read-only shell: command not in whitelist: $cmd")
    }
}
