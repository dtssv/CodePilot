package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import org.springframework.stereotype.Component;
import java.util.*;

/** Finalize node (terminal): summarizes results, sets done reason to final. */
@Component
public class FinalizeAction implements NodeAction {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "finalize");
        updates.put("doneReason", "final");
        return updates;
    }
}