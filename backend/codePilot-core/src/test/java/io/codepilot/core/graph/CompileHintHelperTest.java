package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CompileHintHelperTest {

  @Test
  void directive_whenCmakeFailed_prefersGppOverCmakeBuild() {
    String meta = "CMakeLists.txt detected\nRoot directory entries";
    var state =
        new OverAllState(
            Map.of(
                SessionExecutionFacts.STATE_KEY,
                Map.of("failedFamilies", List.of("cmake")),
                "input",
                "compile and run unit tests"));
    String directive = CompileHintHelper.directive(meta, "compile and run unit tests", state);
    assertTrue(directive.contains("CMake is NOT available"));
    assertTrue(directive.contains("g++"));
    assertFalse(directive.contains("cmake --build build -j"));
  }
}
