package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SessionExecutionFactsTest {

  @Test
  void recordsPlanPivotWhenAlternateApproachSucceeds() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "c1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "result",
            Map.of("command", "cmake --build build -j", "exitCode", 127)));
    gathered.put(
        "g1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "g++ -std=c++20 -o main_program main.cpp RBTree.cpp",
                "exitCode",
                0)));

    Map<String, Object> facts =
        SessionExecutionFacts.mergeFromGathered(new OverAllState(Map.of()), gathered);

    assertTrue(SessionExecutionFacts.planPivot(new OverAllState(Map.of(SessionExecutionFacts.STATE_KEY, facts))));
    assertTrue(stringList(facts, "primaryTargets").contains("./main_program"));
  }

  @Test
  void recordsPivotForNonCompileScenario() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "t1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "result",
            Map.of("command", "mvn test -q", "exitCode", 1)));
    gathered.put(
        "t2",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of("command", "pytest tests/unit -q", "exitCode", 0)));

    Map<String, Object> facts =
        SessionExecutionFacts.mergeFromGathered(new OverAllState(Map.of()), gathered);

    assertTrue(SessionExecutionFacts.planPivot(new OverAllState(Map.of(SessionExecutionFacts.STATE_KEY, facts))));
    assertTrue(stringList(facts, "failedFamilies").contains("maven"));
    assertTrue(stringList(facts, "successfulFamilies").contains("pytest"));
  }

  @Test
  void adaptationDirectiveEmittedWithoutCompileRunIntent() {
    Map<String, Object> facts = new HashMap<>();
    facts.put("planPivot", true);
    facts.put("pivotSummary", "docker failed; ran locally");
    facts.put("primaryTargets", List.of("./app.jar"));
    facts.put("failedAttempts", List.of("docker build ."));
    facts.put("successfulOutcomes", List.of("java -jar app.jar"));

    var state = new OverAllState(Map.of("sessionExecutionFacts", facts, "input", "部署并验证服务"));

    String directive = SessionExecutionFacts.adaptationDirective(state);
    assertTrue(directive.contains("SESSION EXECUTION FACTS"));
    assertTrue(directive.contains("app.jar"));
  }

  @Test
  void listingBuildAloneDoesNotSatisfyStepAfterPivot() {
    Map<String, Object> facts = new HashMap<>();
    facts.put("planPivot", true);
    facts.put("primaryTargets", List.of("./main_program"));
    facts.put("failedAttempts", List.of("cmake --build build"));
    facts.put("failedFamilies", List.of("cmake"));
    facts.put("successfulFamilies", List.of("g++"));

    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list1",
        Map.of("kind", "fs.list", "ok", true, "result", Map.of("path", "build")));

    var state =
        stateWithFacts(
            facts,
            "检查 build 目录中的可执行文件",
            1,
            List.of(
                step("s1", "编译", "completed", "compile"),
                step("s2", "检查 build 目录中的可执行文件", "in_progress", "run")),
            "run");

    assertFalse(SessionExecutionFacts.inspectGoalMet(state, gathered));
  }

  @Test
  void analyzeIntentNotTreatedAsObsoleteExploreDespiteTitleWords() {
    Map<String, Object> facts = new HashMap<>();
    facts.put("planPivot", true);
    facts.put("primaryTargets", List.of("./twoSum.cpp"));
    facts.put("failedFamilies", List.of("cmake"));
    facts.put("successfulFamilies", List.of("g++"));

    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list1",
        Map.of("kind", "fs.list", "ok", true, "result", Map.of("path", ".")));

    var state =
        stateWithFacts(
            facts,
            "检查并分析报告格式",
            0,
            List.of(step("s1", "检查并分析报告格式", "in_progress", "analyze")),
            "analyze");

    assertFalse(SessionExecutionFacts.inspectGoalMet(state, gathered));
  }

  @Test
  void discoverIntentCanBeObsoleteAfterPivot() {
    Map<String, Object> facts = new HashMap<>();
    facts.put("planPivot", true);
    facts.put("primaryTargets", List.of("./main"));
    facts.put("failedFamilies", List.of("cmake"));
    facts.put("successfulFamilies", List.of("g++"));

    Map<String, Object> gathered = Map.of();

    var state =
        stateWithFacts(
            facts,
            "无关标题",
            0,
            List.of(step("s1", "cmake 目录扫描", "in_progress", "discover")),
            "discover");

    assertTrue(SessionExecutionFacts.inspectGoalMet(state, gathered));
  }

  @Test
  void staleProbeBlocksFailedFamilyRetry() {
    Map<String, Object> facts = new HashMap<>();
    facts.put("planPivot", true);
    facts.put("failedFamilies", List.of("maven"));

    var state = new OverAllState(Map.of("sessionExecutionFacts", facts, "input", "运行测试"));

    assertTrue(SessionExecutionFacts.staleProbeBlockReason("mvn test -q", state).isPresent());
    assertTrue(SessionExecutionFacts.staleProbeBlockReason("pytest -q", state).isEmpty());
  }

  private static OverAllState stateWithFacts(
      Map<String, Object> facts,
      String stepTitle,
      int stepIdx,
      List<Map<String, Object>> steps,
      String phaseIntent) {
    var data = new HashMap<String, Object>();
    data.put("sessionExecutionFacts", facts);
    data.put("input", "请编译并运行 main.cpp");
    data.put("phaseCursor", "p1");
    data.put("userPlan", Map.of("steps", steps));
    data.put(
        "phases",
        List.of(
            Map.of(
                "id",
                "p1",
                "title",
                stepTitle,
                "intent",
                phaseIntent,
                "userStepIndex",
                stepIdx)));
    return new OverAllState(data);
  }

  private static OverAllState stateWithFacts(
      Map<String, Object> facts, String stepTitle, int stepIdx, List<Map<String, Object>> steps) {
    return stateWithFacts(facts, stepTitle, stepIdx, steps, "run");
  }

  private static Map<String, Object> step(String id, String title, String status, String intent) {
    return Map.of("id", id, "title", title, "status", status, "intent", intent);
  }

  @SuppressWarnings("unchecked")
  private static List<String> stringList(Map<String, Object> map, String key) {
    return (List<String>) map.get(key);
  }
}
