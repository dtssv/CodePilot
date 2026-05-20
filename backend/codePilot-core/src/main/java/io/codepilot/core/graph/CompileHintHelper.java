package io.codepilot.core.graph;

/** Injects intent-aligned compile/run workflow guidance for the LLM. */
public final class CompileHintHelper {

  private CompileHintHelper() {}

  public static String directive(String projectMeta, String userInput) {
    if (!ShellCommandGate.isCompileRunIntent(userInput)) {
      return "";
    }
    String meta = projectMeta == null ? "" : projectMeta;
    boolean hasCMake = containsFile(meta, "CMakeLists.txt");
    boolean hasMakefile = containsFile(meta, "Makefile");
    boolean hasMainCpp = containsFile(meta, "main.cpp");

    StringBuilder sb = new StringBuilder();
    sb.append("\n\n[COMPILE/RUN — every command must serve the user's request]\n");
    sb.append("User goal: ").append(userInput.trim()).append("\n");
    sb.append(
        "Before each shell.exec, ask: does this directly advance that goal? If not, skip it.\n");
    sb.append(
        "Prefer the shortest path: read build config when needed → build → run → check output if the user cares about results.\n");
    sb.append("One tool per generate response. Use [PROJECT CONTEXT] and [GATHERED CONTEXT] — do not rediscover what you already know.\n");
    sb.append("\nTypical progression (adapt to project; stop when the goal is met):\n");
    if (hasCMake) {
      sb.append(
          "  • Unknown target/binary: fs.read CMakeLists.txt (or cmake --build with verbose output).\n");
      sb.append(
          "  • Build: cmake --build build -j (or cmake -S . -B build then build).\n");
      sb.append(
          "  • Run: execute the binary for the file/target the user named.\n");
      sb.append(
          "  • User asked to clean/rebuild: rm -rf build or reconfigure is appropriate.\n");
      sb.append(
          "  • User asked to find/locate files: find/grep is appropriate.\n");
    } else if (hasMakefile) {
      sb.append("  • Read Makefile if targets are unclear → make -j → run binary.\n");
    } else if (hasMainCpp) {
      sb.append(
          "  • Read main.cpp only if flags/includes are unclear → g++ … → ./binary.\n");
    } else {
      sb.append("  • Discover build system (fs.read/list) → build → run.\n");
    }
    sb.append(
        "\nAfter success: do not add unrelated probes. After failure: read stderr, change approach — not blind retries.\n");
    sb.append(
        "If cmake is missing or failed: use g++/make directly — do NOT retry the same cmake command.\n");
    sb.append(
        "If [GATHERED CONTEXT] shows a successful compile/run, use textOutput — do not repeat build/run.\n");
    sb.append(
        "Plan checklist steps are hints; satisfy the user's goal, not every literal command in the plan.\n");
    sb.append(
        "When [SESSION EXECUTION FACTS] shows a plan pivot, later steps MUST follow primary targets "
            + "there — not paths/commands from the outdated plan.\n");
    sb.append("toolCalls use \"name\" (not \"kind\"). JSON only inside <<<GRAPH_JSON>>> … <<<END>>>.\n");
    return sb.toString();
  }

  private static boolean containsFile(String meta, String name) {
    return meta.contains(name) || meta.contains("  " + name);
  }
}
