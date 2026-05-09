package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.StateGraph;
import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.alibaba.cloud.ai.graph.node.Node;
import com.alibaba.cloud.ai.graph.edge.Edge;
import com.alibaba.cloud.ai.graph.checkpoint.config.CheckpointConfig;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.actions.*;
import io.codepilot.core.sse.SseEvents;
import io.codepilot.core.conversation.SseFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

import java.util.Map;

/**
 * Graph-engine based conversation service using Spring AI Alibaba Graph (StateGraph).
 *
 * <p>Replaces the self-implemented GraphOrchestrator with Spring AI Alibaba's
 * declarative StateGraph API (Java port of LangGraph). The graph is compiled once
 * at startup and invoked per-request with the request state.
 *
 * <p>Key nodes: intake → planning → preCheck → generate → applyPatch → verify
 *   → commit/repair → finalize. Plus gather/reenter for info collection.
 *
 * <p>This service is called by {@link io.codepilot.core.conversation.ConversationService}
 * when {@code policy.engine == "graph"}.
 */
@Service
public class GraphEngineService {

    private static final Logger log = LoggerFactory.getLogger(GraphEngineService.class);

    private final IntakeAction intakeAction;
    private final PlanningAction planningAction;
    private final PreCheckAction preCheckAction;
    private final GenerateAction generateAction;
    private final ApplyPatchAction applyPatchAction;
    private final VerifyAction verifyAction;
    private final RepairAction repairAction;
    private final GatherAction gatherAction;
    private final ReenterAction reenterAction;
    private final CommitAction commitAction;
    private final AskUserAction askUserAction;
    private final FinalizeAction finalizeAction;
    private final SseFactory sse;

    public GraphEngineService(
            IntakeAction intakeAction,
            PlanningAction planningAction,
            PreCheckAction preCheckAction,
            GenerateAction generateAction,
            ApplyPatchAction applyPatchAction,
            VerifyAction verifyAction,
            RepairAction repairAction,
            GatherAction gatherAction,
            ReenterAction reenterAction,
            CommitAction commitAction,
            AskUserAction askUserAction,
            FinalizeAction finalizeAction,
            SseFactory sse) {
        this.intakeAction = intakeAction;
        this.planningAction = planningAction;
        this.preCheckAction = preCheckAction;
        this.generateAction = generateAction;
        this.applyPatchAction = applyPatchAction;
        this.verifyAction = verifyAction;
        this.repairAction = repairAction;
        this.gatherAction = gatherAction;
        this.reenterAction = reenterAction;
        this.commitAction = commitAction;
        this.askUserAction = askUserAction;
        this.finalizeAction = finalizeAction;
        this.sse = sse;
    }

    /**
     * Builds and executes the Graph for a conversation run request.
     * Returns SSE events as a reactive stream.
     */
    public Flux<ServerSentEvent<String>> run(ConversationRunRequest req) {
        try {
            var graph = buildGraph();
            var initialState = intakeAction.buildInitialState(req);

            // Execute graph - Spring AI Alibaba Graph returns the final state after traversal
            var resultState = graph.invoke(initialState);

            // Convert graph execution results to SSE events
            return buildSseFromResult(resultState);
        } catch (Exception e) {
            log.error("Graph engine execution failed", e);
            return Flux.just(
                    sse.error(50001, "Graph engine error: " + e.getMessage()),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
        }
    }

    private StateGraph<OverAllState> buildGraph() throws Exception {
        var graph = new StateGraph<>(OverAllState::new);

        // ── Define Nodes ──
        graph.addNode("intake", intakeAction);
        graph.addNode("planning", planningAction);
        graph.addNode("preCheck", preCheckAction);
        graph.addNode("generate", generateAction);
        graph.addNode("applyPatch", applyPatchAction);
        graph.addNode("verify", verifyAction);
        graph.addNode("repair", repairAction);
        graph.addNode("gather", gatherAction);
        graph.addNode("reenter", reenterAction);
        graph.addNode("commit", commitAction);
        graph.addNode("askUser", askUserAction);
        graph.addNode("finalize", finalizeAction);

        // ── Define Edges ──
        graph.setEntryPoint("intake");
        graph.addEdge("intake", "planning");

        // Planning → may need info or proceed to phase loop
        graph.addConditionalEdges("planning", planningAction::routeAfterPlanning,
                Map.of("preCheck", "preCheck", "gather", "gather", "finalize", "finalize"));

        graph.addEdge("preCheck", "generate");

        // Generate → may need info, or produce toolCalls
        graph.addConditionalEdges("generate", generateAction::routeAfterGenerate,
                Map.of("applyPatch", "applyPatch", "gather", "gather", "askUser", "askUser"));

        graph.addEdge("applyPatch", "verify");

        // Verify → success/fail/uncertain
        graph.addConditionalEdges("verify", verifyAction::routeAfterVerify,
                Map.of("commit", "commit", "repair", "repair", "askUser", "askUser"));

        // Repair → may need info, or retry verify
        graph.addConditionalEdges("repair", repairAction::routeAfterRepair,
                Map.of("applyPatch", "applyPatch", "gather", "gather", "askUser", "askUser"));

        // Gather → Reenter
        graph.addEdge("gather", "reenter");

        // Reenter → back to the originating node
        graph.addConditionalEdges("reenter", reenterAction::routeAfterReenter,
                Map.of("planning", "planning", "preCheck", "preCheck",
                        "generate", "generate", "repair", "repair"));

        // Commit → next phase or finalize
        graph.addConditionalEdges("commit", commitAction::routeAfterCommit,
                Map.of("preCheck", "preCheck", "finalize", "finalize"));

        // AskUser and Finalize are terminal
        graph.setFinishPoint("askUser");
        graph.setFinishPoint("finalize");

        return graph.compile();
    }

    private Flux<ServerSentEvent<String>> buildSseFromResult(OverAllState state) {
        // Extract SSE events accumulated during graph execution
        @SuppressWarnings("unchecked")
        var events = (java.util.List<Map<String, Object>>) state.value("sseEvents").orElse(java.util.List.of());
        var sseList = events.stream()
                .map(evt -> sse.event(
                        (String) evt.get("event"),
                        evt.get("data")))
                .collect(java.util.stream.Collectors.toList());

        String doneReason = (String) state.value("doneReason").orElse("final");
        sseList.add(sse.event(SseEvents.DONE, Map.of("reason", doneReason)));

        return Flux.fromIterable(sseList);
    }
}