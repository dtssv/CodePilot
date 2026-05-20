package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PhaseGoalHelperTest {

  @Test
  void compileStepSatisfiedWhenGppSucceededAfterCmakeFailed() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "f1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "errorMessage",
            "cmake: command not found"));
    gathered.put(
        "ok1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "g++ -std=c++11 main.cpp RBTree.cpp -o main_test",
                "exitCode",
                0,
                "stdout",
                "")));

    var state =
        stateWithPlan(
            "p3",
            List.of(
                step("s1", "检查 CMake 配置", "completed", "inspect"),
                step("s2", "准备构建目录", "completed", "prepare"),
                step("s3", "编译项目", "in_progress", "compile"),
                step("s4", "运行可执行文件", "pending", "run")),
            gathered);

    assertEquals(PhaseGoalHelper.StepKind.COMPILE, PhaseGoalHelper.inferStepKind(state));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
    assertFalse(PhaseOutcomeHelper.hasToolFailures(stateWithFailureFlag(state)));
  }

  @Test
  void runStepSatisfiedWhenBinaryExecuted() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "run1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of("command", "./main_test", "exitCode", 0, "stdout", "ok")));

    var state =
        stateWithPlan(
            "p4",
            List.of(
                step("s1", "检查", "completed", "inspect"),
                step("s2", "准备", "completed", "prepare"),
                step("s3", "编译项目", "completed", "compile"),
                step("s4", "运行可执行文件", "in_progress", "run")),
            gathered);

    assertEquals(PhaseGoalHelper.StepKind.RUN, PhaseGoalHelper.inferStepKind(state));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void listingBuildDirDoesNotSatisfyRunTargetStep() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list1",
        Map.of("kind", "fs.list", "ok", true, "result", Map.of("path", "build")));

    var state =
        stateWithPlan(
            "p-run",
            List.of(
                step("s1", "编译", "completed", "compile"),
                step("s2", "检查 build 目录中的可执行文件", "in_progress", "run")),
            gathered);

    assertFalse(PhaseGoalHelper.currentStepGoalSatisfied(state));
    assertEquals(PhaseGoalHelper.StepKind.RUN, PhaseGoalHelper.inferStepKind(state));
  }

  @Test
  void inferKindFromIntentSlugNotTitleKeywords() {
    var state =
        stateWithPlan(
            "p-analyze",
            List.of(step("s1", "Random title without analysis words", "in_progress", "analyze")),
            Map.of());

    assertEquals(PhaseGoalHelper.StepKind.ANALYZE, PhaseGoalHelper.inferStepKind(state));
  }

  @Test
  void analyzeNotInferredFromIncidentalTitleWord() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list1",
        Map.of("kind", "fs.list", "ok", true, "result", Map.of("path", ".")));

    var state =
        stateWithPlan(
            "p-disc",
            List.of(step("s1", "分析报告格式说明", "in_progress", "discover")),
            gathered);

    assertEquals(PhaseGoalHelper.StepKind.DISCOVER, PhaseGoalHelper.inferStepKind(state));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void synthesizeStepNeedsSessionReadsAndPhaseOutput() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put("gatheredInfo", Map.of());
    data.put("sessionHasSourceReads", true);
    data.put("phaseHasAnalysisOutput", true);
    data.put("userPlan", Map.of("steps", List.of(step("s3", "整理报告", "in_progress", "synthesize"))));
    data.put(
        "phases",
        List.of(Map.of("id", "p3", "title", "整理报告", "intent", "synthesize", "userStepIndex", 0)));
    var state = new OverAllState(data);

    assertEquals(PhaseGoalHelper.StepKind.SYNTHESIZE, PhaseGoalHelper.inferStepKind(state));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void discoverRequiresTargetFilesWhenInputMentionsLeetcode() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list1",
        Map.of(
            "kind",
            "fs.list",
            "ok",
            true,
            "result",
            Map.of(
                "path",
                ".",
                "entries",
                List.of(Map.of("name", "main.cpp", "path", "main.cpp")))));

    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p1");
    data.put("input", "分析 leetcode 算法复杂度");
    data.put("gatheredInfo", gathered);
    data.put("userPlan", Map.of("steps", List.of(step("s1", "发现文件", "in_progress", "discover"))));
    data.put(
        "phases",
        List.of(Map.of("id", "p1", "title", "发现文件", "intent", "discover", "userStepIndex", 0)));
    var state = new OverAllState(data);

    assertFalse(PhaseGoalHelper.currentStepGoalSatisfied(state));

    gathered.put(
        "list2",
        Map.of(
            "kind",
            "fs.list",
            "ok",
            true,
            "result",
            Map.of(
                "path",
                ".",
                "entries",
                List.of(Map.of("name", "leetcode42.cpp", "path", "leetcode42.cpp")))));
    data.put("gatheredInfo", gathered);
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(new OverAllState(data)));
  }

  @Test
  void reportIntentMapsToSynthesizeNotAnalyze() {
    var state =
        stateWithPlan(
            "p3",
            List.of(step("s3", "整理 Markdown", "in_progress", "report")),
            Map.of());
    assertEquals(PhaseGoalHelper.StepKind.SYNTHESIZE, PhaseGoalHelper.inferStepKind(state));
  }

  @Test
  void lsBuildIsNotProgramExecution() {
    assertFalse(PhaseGoalHelper.looksLikeProgramExecution("ls build"));
    assertTrue(PhaseGoalHelper.looksLikeProgramExecution("./main_test"));
  }

  private static OverAllState stateWithFailureFlag(OverAllState base) {
    var data = new HashMap<>(base.data());
    data.put("phaseToolsHadFailure", true);
    return new OverAllState(data);
  }

  private static OverAllState stateWithPlan(
      String phaseId, List<Map<String, Object>> steps, Map<String, Object> gathered) {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", phaseId);
    data.put("gatheredInfo", gathered);
    data.put("phaseToolsHadFailure", true);
    data.put("userPlan", Map.of("steps", steps, "status", "in_progress"));
    data.put(
        "phases",
        List.of(
            Map.of("id", "p3", "title", "编译项目", "intent", "compile", "userStepIndex", 2),
            Map.of("id", "p4", "title", "运行可执行文件", "intent", "run", "userStepIndex", 3),
            Map.of(
                "id",
                "p-run",
                "title",
                "检查 build 目录中的可执行文件",
                "intent",
                "run",
                "userStepIndex",
                1),
            Map.of("id", "p-analyze", "title", "Step", "intent", "analyze", "userStepIndex", 0),
            Map.of("id", "p-disc", "title", "Step", "intent", "discover", "userStepIndex", 0)));
    data.put(
        "intakeIntent",
        Map.of("allowShellExec", true, "needsPlanning", true, "needsTools", true));
    data.put("workflowCompileRun", true);
    return new OverAllState(data);
  }

  private static Map<String, Object> step(String id, String title, String status, String intent) {
    return Map.of("id", id, "title", title, "status", status, "intent", intent);
  }
}
