package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ShellCommandGateTest {

  @Test
  void allowsFindWhenNoPriorDuplicate() {
    var reason =
        ShellCommandGate.blockReason(
            "find . -name '*.cpp'",
            "CMakeLists.txt",
            "编译并运行 main.cpp",
            Map.of());
    assertFalse(reason.isPresent());
  }

  @Test
  void allowsCmakeCleanWhenUserIntentIsCompileRun() {
    var reason =
        ShellCommandGate.blockReason(
            "rm -rf build && cmake -S . -B build",
            "CMakeLists.txt",
            "clean rebuild and run",
            Map.of());
    assertFalse(reason.isPresent());
  }

  @Test
  void blocksRepeatedFailedCommand() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "s1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "result",
            Map.of("command", "cmake --build build -j", "exitCode", 2)));
    var reason =
        ShellCommandGate.blockReason(
            "cmake --build build -j",
            "CMakeLists.txt",
            "compile",
            gathered);
    assertTrue(reason.isPresent());
    assertTrue(reason.get().contains("failed"));
  }

  @Test
  void blocksExactDuplicateInSameTurn() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "s1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of("command", "cmake --build build -j", "exitCode", 0)));
    var reason =
        ShellCommandGate.blockReason(
            "cmake --build build -j",
            "CMakeLists.txt",
            "compile",
            gathered);
    assertTrue(reason.isPresent());
    assertTrue(reason.get().contains("already ran"));
  }
}
