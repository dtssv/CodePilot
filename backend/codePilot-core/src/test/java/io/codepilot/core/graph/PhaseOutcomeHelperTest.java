package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class PhaseOutcomeHelperTest {

  @Test
  void detectsShellFailure() {
    assertTrue(
        PhaseOutcomeHelper.gatheredHasFailures(
            Map.of(
                "x",
                Map.of(
                    "kind",
                    "shell.exec",
                    "ok",
                    false,
                    "result",
                    Map.of("exitCode", 1, "command", "./build/test")))));
  }

  @Test
  void detectsFsListFailure() {
    assertTrue(
        PhaseOutcomeHelper.gatheredHasFailures(
            Map.of(
                "x",
                Map.of(
                    "kind",
                    "fs.list",
                    "errorMessage",
                    "path under denied directory: build"))));
  }

  @Test
  void passesWhenAllOk() {
    assertFalse(
        PhaseOutcomeHelper.gatheredHasFailures(
            Map.of(
                "x",
                Map.of(
                    "kind",
                    "fs.read",
                    "ok",
                    true,
                    "result",
                    Map.of("path", "CMakeLists.txt", "content", "project(test)")))));
  }
}
