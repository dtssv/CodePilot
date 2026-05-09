package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.stereotype.Component;
import java.util.*;

/** AskUser node (terminal): emits needs_input SSE, sets done reason to awaiting_user_input. */
@Component
public class AskUserAction implements NodeAction<OverAllState> {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "askUser");
        updates.put("doneReason", "awaiting_user_input");
        GraphSseHelper.emitEvent(state, "needs_input", Map.of("title", "Need your input to continue"));
        return updates;
    }
}