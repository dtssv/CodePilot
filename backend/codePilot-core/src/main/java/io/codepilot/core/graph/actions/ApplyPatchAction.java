package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import org.springframework.stereotype.Component;
import java.util.*;

/** ApplyPatch node: emits tool_call SSE for client-side execution, awaits result via ToolResultBus. */
@Component
public class ApplyPatchAction implements NodeAction<OverAllState> {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "applyPatch");
        // TODO: emit tool_call SSE, await ToolResultBus response
        return updates;
    }
}