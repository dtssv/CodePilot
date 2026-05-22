package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.graph.actions.GenerateAction;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GenerateActionRouteTest {

  @Test
  void routeAfterGenerate_askUserResultRoutesBeforeSatisfiedCommit() {
    var action = new GenerateAction(null, null, null, null);
    var state =
        new OverAllState(
            Map.of(
                "generateResult",
                "askUser",
                "overallGoalUnmet",
                true,
                "approachEscalationDone",
                true,
                "phaseCursor",
                "p5",
                "userPlan",
                Map.of("steps", List.of(Map.of("title", "compile and run", "description", "verify"))),
                "userPlanStepCursor",
                0));
    assertEquals("askUser", action.routeAfterGenerate(state));
  }

  @Test
  void routeAfterGenerate_escalationUnmetRoutesToAskUserNotCommit() {
    var action = new GenerateAction(null, null, null, null);
    var data = new HashMap<String, Object>();
    data.put("generateResult", "textOutput");
    data.put("overallGoalUnmet", true);
    data.put("approachEscalationDone", true);
    data.put("phaseCursor", "p5");
    data.put(
        "userPlan",
        Map.of(
            "steps",
            List.of(
                Map.of("title", "analyze", "description", "read sources"),
                Map.of("title", "compile and run", "description", "cmake build"))));
    data.put("userPlanStepCursor", 1);
    data.put("gatheredInfo", Map.of());
    data.put("phaseGeneratePasses", 1);
    assertEquals("askUser", action.routeAfterGenerate(new OverAllState(data)));
  }
}
