package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

class GatheredInfoFormatterTest {

  @Test
  void formatsDirectShellSuccessWithExitCode() {
    Map<String, Object> gathered =
        Map.of(
            "direct-1",
            Map.of(
                "kind",
                "shell.exec",
                "id",
                "direct-1",
                "ok",
                true,
                "result",
                Map.of(
                    "command",
                    "g++ -std=c++17 main.cpp -o app",
                    "exitCode",
                    0,
                    "stdout",
                    "built ok",
                    "stderr",
                    "",
                    "cwd",
                    "/proj")));

    String out = GatheredInfoFormatter.format(gathered);
    assertThat(out).contains("[OK] shell.exec");
    assertThat(out).contains("exitCode=0");
    assertThat(out).contains("g++");
    assertThat(out).doesNotContain("[FAILED]");
  }

  @Test
  void formatsDirectShellFailureFromResultBody() {
    Map<String, Object> gathered =
        Map.of(
            "direct-2",
            Map.of(
                "kind",
                "shell.exec",
                "id",
                "direct-2",
                "ok",
                false,
                "errorMessage",
                "exit code 1",
                "result",
                Map.of(
                    "command",
                    "cmake -S . -B build",
                    "exitCode",
                    1,
                    "stderr",
                    "CMake Error: no CMakeLists.txt",
                    "stdout",
                    "")));

    String out = GatheredInfoFormatter.format(gathered);
    assertThat(out).contains("[FAILED]");
    assertThat(out).contains("CMake Error");
    assertThat(out).contains("cmake -S . -B build");
  }

  @Test
  void infersOkWhenDirectEntryOmitsOkButShellSucceeded() {
    Map<String, Object> gathered =
        Map.of(
            "direct-3",
            Map.of(
                "kind",
                "shell.exec",
                "result",
                Map.of("command", "pwd", "exitCode", 0, "stdout", "/proj\n", "stderr", "")));

    assertThat(GatheredInfoFormatter.entrySucceeded((Map<String, Object>) gathered.get("direct-3")))
        .isTrue();
    assertThat(GatheredInfoFormatter.format(gathered)).contains("[OK]");
  }
}
