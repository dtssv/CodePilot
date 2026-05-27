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
  void purposeCompileOverridesRegexMatch() {
    // "which g++" with purpose="compile" should count as successful compile
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "build",
        Map.of(
            "kind", "shell.exec",
            "ok", true,
            "purpose", "compile",
            "result", Map.of("command", "which g++", "exitCode", 0, "stdout", "/usr/bin/g++")));
    assertTrue(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

  @Test
  void purposeProbePreventsCompileEvenWithGppCommand() {
    // "g++ -o test main.cpp" with purpose="probe" should NOT count as successful compile
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "probe",
        Map.of(
            "kind", "shell.exec",
            "ok", true,
            "purpose", "probe",
            "result", Map.of("command", "g++ -o test main.cpp", "exitCode", 0, "stdout", "")));
    assertFalse(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

  @Test
  void purposeRunOverridesLooksLikeProgramExecution() {
    // "dotnet run" with purpose="run" should count as successful run
    // (dotnet run would not match RUN_CMD regex)
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "run1",
        Map.of(
            "kind", "shell.exec",
            "ok", true,
            "purpose", "run",
            "result", Map.of("command", "dotnet run", "exitCode", 0, "stdout", "Hello World")));
    assertTrue(PhaseGoalHelper.hasSuccessfulRun(gathered));
  }

  @Test
  void purposeProbePreventsRun() {
    // "ls -la build/" with purpose="probe" should NOT count as successful run
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "probe",
        Map.of(
            "kind", "shell.exec",
            "ok", true,
            "purpose", "probe",
            "result", Map.of("command", "./main", "exitCode", 0, "stdout", "output")));
    assertFalse(PhaseGoalHelper.hasSuccessfulRun(gathered));
  }

  @Test
  void purposeAbsentFallsBackToRegex() {
    // No purpose field — should fall back to COMPILE_CMD regex
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "build",
        Map.of(
            "kind", "shell.exec",
            "ok", true,
            "result", Map.of("command", "g++ -o test main.cpp", "exitCode", 0, "stdout", "")));
    assertTrue(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

  @Test
  void whichGppIsNotSuccessfulCompile() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "probe",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "which g++",
                "exitCode",
                0,
                "stdout",
                "/usr/bin/g++")));

    var state =
        stateWithPlan(
            "p3",
            List.of(
                step("s1", "检查编译器", "completed", "inspect"),
                step("s2", "编译项目", "in_progress", "compile"),
                step("s3", "运行可执行文件", "pending", "run")),
            gathered);

    assertEquals(PhaseGoalHelper.StepKind.COMPILE, PhaseGoalHelper.inferStepKind(state));
    assertFalse(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void echoGppIsNotSuccessfulCompile() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "probe",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "echo g++",
                "exitCode",
                0,
                "stdout",
                "g++")));

    assertFalse(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

  @Test
  void typeClangIsNotSuccessfulCompile() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "probe",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "type clang++",
                "exitCode",
                0,
                "stdout",
                "clang++ is /usr/bin/clang++")));

    assertFalse(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

  @Test
  void pipedCompileCommandIsSuccessfulCompile() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "build",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            true,
            "result",
            Map.of(
                "command",
                "cmake .. && make -j4",
                "exitCode",
                0,
                "stdout",
                "Build complete")));

    assertTrue(PhaseGoalHelper.hasSuccessfulCompile(gathered));
  }

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
                List.of(Map.of("name", "main.cpp", "type", "file", "path", "main.cpp")))));

    var state =
        stateWithPlan(
            "p-disc",
            List.of(step("s1", "分析报告格式说明", "in_progress", "discover")),
            gathered);

    assertEquals(PhaseGoalHelper.StepKind.DISCOVER, PhaseGoalHelper.inferStepKind(state));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void analyzeStepMetWithEmbeddedSelectionAndPhaseOutput() {
    String input =
        "请帮我重构这段选中的代码\n"
            + "Context: buildTree106.cpp :1-69\n"
            + "```C++\n"
            + "#include <vector>\n"
            + "struct TreeNode { int val; };\n"
            + "```";
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p1");
    data.put("input", input);
    data.put("gatheredInfo", Map.of());
    data.put("phaseHasAnalysisOutput", true);
    data.put(
        "userPlan",
        Map.of("steps", List.of(step("s1", "分析现有代码问题", "in_progress", "analyze"))));
    data.put(
        "phases",
        List.of(Map.of("id", "p1", "title", "分析", "intent", "analyze", "userStepIndex", 0)));
    var state = new OverAllState(data);

    assertTrue(PhaseGoalHelper.inputHasEmbeddedSource(state));
    assertTrue(PhaseGoalHelper.analyzeGoalMet(state, Map.of()));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state));
  }

  @Test
  void analyzeStepNotMetWithoutPhaseOutputEvenWithEmbeddedSource() {
    String input = "Context: foo.cpp :1-10 ```cpp int x; ```";
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p1");
    data.put("input", input);
    data.put("gatheredInfo", Map.of());
    data.put(
        "userPlan",
        Map.of("steps", List.of(step("s1", "分析", "in_progress", "analyze"))));
    data.put(
        "phases",
        List.of(Map.of("id", "p1", "intent", "analyze", "userStepIndex", 0)));
    var state = new OverAllState(data);

    assertTrue(PhaseGoalHelper.inputHasEmbeddedSource(state));
    assertFalse(PhaseGoalHelper.analyzeGoalMet(state, Map.of()));
    assertFalse(PhaseGoalHelper.currentStepGoalSatisfied(state));
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
  void inspectBlocksCommitWhenSourceReadFailed() {
    var gathered = new HashMap<String, Object>();
    gathered.put(
        "read1",
        Map.of(
            "kind",
            "fs.read",
            "ok",
            true,
            "result",
            Map.of("path", "leetcode42.cpp", "content", "int main(){}")));
    gathered.put(
        "read2",
        Map.of("kind", "fs.read", "ok", false, "errorMessage", "timeout"));
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p2");
    data.put("gatheredInfo", gathered);
    data.put(
        "phases",
        List.of(Map.of("id", "p2", "intent", "inspect", "userStepIndex", 1)));
    data.put(
        "userPlan",
        Map.of(
            "steps",
            List.of(
                step("s1", "发现", "completed", "discover"),
                step("s2", "读取", "in_progress", "inspect"))));
    assertFalse(PhaseGoalHelper.inspectGoalMet(new OverAllState(data), gathered));
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

  @Test
  void discoverStepMetWithNonemptyListing() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "list_out",
        Map.of(
            "kind",
            "fs.list",
            "ok",
            true,
            "result",
            Map.of(
                "path",
                "reports",
                "entries",
                List.of(Map.of("name", "summary.md", "type", "file")))));

    var state =
        stateWithPlan(
            "p-disc",
            List.of(step("s1", "Discover project files", "in_progress", "discover")),
            gathered);

    assertTrue(PhaseGoalHelper.discoverGoalMet(state, gathered));
  }

  @Test
  void failureRepairRoutesWhenToolsFailedAndGoalUnmet() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "sh",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "errorMessage",
            "cmake: command not found",
            "result",
            Map.of("command", "cmake --build build", "stderr", "/bin/bash: cmake: command not found")));

    var state =
        stateWithPlan(
            "p6",
            List.of(step("s6", "编译测试", "in_progress", "compile")),
            gathered);

    assertTrue(PhaseFailureRepairHelper.shouldRouteToRepair(state));
    assertFalse(PhaseFailureRepairHelper.shouldAbandonPhase(state));
  }

  @Test
  void failureRepairAbandonsAfterMaxAttempts() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p6");
    data.put("phaseFailureRetries", 10);
    data.put("phases", List.of(Map.of("id", "p6", "intent", "compile")));
    data.put("userPlan", Map.of("steps", List.of(step("s6", "编译", "in_progress", "compile"))));
    assertTrue(PhaseFailureRepairHelper.shouldAbandonPhase(new OverAllState(data)));
  }

  @Test
  void compileStepEscapesWhenPassesHighDespiteShellFailure() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "shell1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "errorMessage",
            "cmake: command not found"));

    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p6");
    data.put("gatheredInfo", gathered);
    data.put("phaseToolsHadFailure", true);
    data.put("phaseGeneratePasses", 10);
    data.put(
        "userPlan",
        Map.of(
            "steps",
            List.of(step("s6", "编译并测试", "in_progress", "compile")),
            "status",
            "in_progress"));
    data.put(
        "phases",
        List.of(Map.of("id", "p6", "title", "编译并测试", "intent", "compile", "userStepIndex", 0)));
    data.put("intakeIntent", Map.of("allowShellExec", true, "needsPlanning", true));
    data.put("workflowCompileRun", true);

    var state = new OverAllState(data);
    assertEquals(PhaseGoalHelper.StepKind.COMPILE, PhaseGoalHelper.inferStepKind(state));
    assertFalse(PhaseGoalHelper.currentStepGoalSatisfied(state));
    assertTrue(PhaseGoalHelper.shouldAdvanceCompileRunDespiteToolFailures(state));
  }

  @Test
  void compileStepEscapesWhenTestFilesWrittenDespiteShellFailure() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "gpp",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "errorMessage",
            "exitCode=1"));

    var facts = new HashMap<String, Object>();
    SessionExecutionFacts.recordWrittenFile(facts, "test_rbtree.cpp");

    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p6");
    data.put("gatheredInfo", gathered);
    data.put("phaseToolsHadFailure", true);
    data.put("phaseGeneratePasses", 3);
    data.put(SessionExecutionFacts.STATE_KEY, facts);
    data.put(
        "userPlan",
        Map.of(
            "steps",
            List.of(step("s6", "编译并测试", "in_progress", "compile")),
            "status",
            "in_progress"));
    data.put(
        "phases",
        List.of(Map.of("id", "p6", "title", "编译并测试", "intent", "compile", "userStepIndex", 0)));
    data.put("intakeIntent", Map.of("allowShellExec", true, "needsPlanning", true));

    var state = new OverAllState(data);
    assertTrue(PhaseGoalHelper.shouldAdvanceCompileRunDespiteToolFailures(state));
  }

  @Test
  void inspectStepRequiresSuccessfulSourceRead() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "read_fail",
        Map.of(
            "kind",
            "fs.read",
            "ok",
            false,
            "errorMessage",
            "file does not exist: missing/module.cpp",
            "result",
            Map.of("path", "missing/module.cpp")));

    var state =
        stateWithPlan(
            "p-analyze",
            List.of(step("s1", "Read source files", "in_progress", "inspect")),
            gathered);

    assertFalse(PhaseGoalHelper.inspectGoalMet(state, gathered));
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

    String intent = "code-change";
    int stepIdx = 0;
    String title = "Step";
    for (int i = 0; i < steps.size(); i++) {
      Map<String, Object> st = steps.get(i);
      if ("in_progress".equals(st.get("status"))) {
        intent = String.valueOf(st.getOrDefault("intent", "code-change"));
        title = String.valueOf(st.getOrDefault("title", "Step"));
        stepIdx = i;
        break;
      }
    }
    data.put(
        "phases",
        List.of(
            Map.of(
                "id", phaseId,
                "title", title,
                "intent", intent,
                "userStepIndex", stepIdx)));
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
