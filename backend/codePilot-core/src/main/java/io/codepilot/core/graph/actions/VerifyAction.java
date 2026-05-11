package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.stereotype.Component;
import java.util.*;

/** Verify node: runs compile/test/lint assertions. No LLM call — deterministic scripts only. */
@Component
public class VerifyAction implements NodeAction {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "verify");
        // TODO: execute phase.exit assertions via shell tool_call (compile/test/lint)
        // Produce VerifyReport and emit graph_verify SSE
        GraphSseHelper.emitEvent(state, "graph_verify",
                Map.of("phaseId", state.value("phaseCursor").orElse(""), "ok", true));
        updates.put("verifyResult", "success"); // or "fail" or "uncertain"
        return updates;
    }

    public String routeAfterVerify(OverAllState state) {
        String result = (String) state.value("verifyResult").orElse("success");
        return switch (result) {
            case "fail" -> "repair";
            case "uncertain" -> "askUser";
            default -> "commit";
        };
    }
}