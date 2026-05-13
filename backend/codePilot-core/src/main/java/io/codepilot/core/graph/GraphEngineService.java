package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.CompiledGraph;
import com.alibaba.cloud.ai.graph.StateGraph;
import com.alibaba.cloud.ai.graph.action.AsyncEdgeAction;
import com.alibaba.cloud.ai.graph.action.AsyncNodeAction;
import io.codepilot.core.conversation.SseFactory;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.actions.*;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

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

    /** Dedicated scheduler for graph engine execution — avoids blocking the ForkJoinPool.commonPool()
     *  and provides bounded elasticity for concurrent agent requests. */
    private final Scheduler graphScheduler = Schedulers.newBoundedElastic(
            Schedulers.DEFAULT_BOUNDED_ELASTIC_SIZE,
            Schedulers.DEFAULT_BOUNDED_ELASTIC_QUEUESIZE,
            "graph-engine", 60, true);

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
    private final SearchEvaluateAction searchEvaluateAction;
    private final SynthesizeAction synthesizeAction;
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
            SearchEvaluateAction searchEvaluateAction,
            SynthesizeAction synthesizeAction,
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
        this.searchEvaluateAction = searchEvaluateAction;
        this.synthesizeAction = synthesizeAction;
        this.sse = sse;
    }

    /**
     * Builds and executes the Graph for a conversation run request.
     * Returns SSE events as a reactive stream.
     *
     * <p>Uses {@code Sinks.Many} to stream SSE events in real-time as each graph node
     * executes, rather than waiting for the entire graph to complete.
     *
     * <p>The graph executes on a dedicated scheduler (C3 fix) instead of
     * ForkJoinPool.commonPool(). Each node's {@code GraphSseHelper.emitEvent()} pushes
     * events directly to the reactive sink, so the client receives tool_call events
     * immediately and can return tool results back to the backend (ToolResultBus).
     */
    public Flux<ServerSentEvent<String>> run(ConversationRunRequest req, String userId) {
        try {
            String template = req.policy() != null && req.policy().graphTemplate() != null
                    ? req.policy().graphTemplate() : "default";
            var graph = "deep-research".equals(template) ? buildDeepResearchGraph() : buildGraph();
            var initialState = intakeAction.buildInitialState(req, userId);
            log.info("GraphEngine initial state: modelId={}, modelSource={}, userId={}, keys={}",
                initialState.value("modelId").orElse(null),
                initialState.value("modelSource").orElse(null),
                initialState.value("userId").orElse(null),
                initialState.keyStrategies().keySet());

            Sinks.Many<ServerSentEvent<String>> liveSink = Sinks.many().unicast().onBackpressureBuffer();

            Runnable graphTask = () -> {
                // Set the ThreadLocal live sink so GraphSseHelper.emitEvent() can push events
                GraphSseHelper.setLiveSink(liveSink, sse);
                // Also register in session-based map so async nodes on different threads can access it (M1 fix)
                String sid = req.sessionId();
                GraphSseHelper.registerSessionSink(sid, liveSink, sse);
                try {
                    var resultState = graph.invoke(initialState.data());
                    log.info("GraphEngine completed: state keys={}",
                        resultState.map(s -> s.data().keySet()).orElse(null));
                    liveSink.tryEmitComplete();
                } catch (Exception e) {
                    log.error("Graph engine execution failed", e);
                    liveSink.tryEmitNext(sse.error(50001, "Graph engine error: " + e.getMessage()));
                    liveSink.tryEmitComplete();
                } finally {
                    GraphSseHelper.clearLiveSink();
                    GraphSseHelper.unregisterSessionSink(sid);
                }
            };
            graphScheduler.schedule(graphTask);

            return liveSink.asFlux();
        } catch (Exception e) {
            log.error("Graph engine execution failed", e);
            return Flux.just(
                    sse.error(50001, "Graph engine error: " + e.getMessage()),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
        }
    }

    private CompiledGraph buildGraph() throws Exception {
        var graph = new StateGraph(IntakeAction::createStateWithStrategies);

        // ── Define Nodes ──
        graph.addNode("intake", AsyncNodeAction.node_async(intakeAction));
        graph.addNode("planning", AsyncNodeAction.node_async(planningAction));
        graph.addNode("preCheck", AsyncNodeAction.node_async(preCheckAction));
        graph.addNode("generate", AsyncNodeAction.node_async(generateAction));
        graph.addNode("applyPatch", AsyncNodeAction.node_async(applyPatchAction));
        graph.addNode("verify", AsyncNodeAction.node_async(verifyAction));
        graph.addNode("repair", AsyncNodeAction.node_async(repairAction));
        graph.addNode("gather", AsyncNodeAction.node_async(gatherAction));
        graph.addNode("reenter", AsyncNodeAction.node_async(reenterAction));
        graph.addNode("commit", AsyncNodeAction.node_async(commitAction));
        graph.addNode("askUser", AsyncNodeAction.node_async(askUserAction));
        graph.addNode("finalize", AsyncNodeAction.node_async(finalizeAction));

        // ── Define Edges ──
        graph.addEdge(StateGraph.START, "intake");
        graph.addEdge("intake", "planning");

        // Planning → may need info or proceed to phase loop
        graph.addConditionalEdges("planning",
                AsyncEdgeAction.edge_async(planningAction::routeAfterPlanning),
                Map.of("preCheck", "preCheck", "gather", "gather", "finalize", "finalize"));

        graph.addEdge("preCheck", "generate");

        // Generate → may need info, produce toolCalls, or textOutput (B3: skip applyPatch)
        graph.addConditionalEdges("generate",
                AsyncEdgeAction.edge_async(generateAction::routeAfterGenerate),
                Map.of("applyPatch", "applyPatch", "gather", "gather",
                        "askUser", "askUser", "commit", "commit"));

        // ApplyPatch → may succeed or fail; fast-path can skip verify (C1)
        graph.addConditionalEdges("applyPatch",
                AsyncEdgeAction.edge_async(applyPatchAction::routeAfterApplyPatch),
                Map.of("verify", "verify", "repair", "repair", "commit", "commit"));

        // Verify → success/fail/uncertain
        graph.addConditionalEdges("verify",
                AsyncEdgeAction.edge_async(verifyAction::routeAfterVerify),
                Map.of("commit", "commit", "repair", "repair", "askUser", "askUser"));

        // Repair → may need info, retry verify, or partial commit (M3)
        graph.addConditionalEdges("repair",
                AsyncEdgeAction.edge_async(repairAction::routeAfterRepair),
                Map.of("applyPatch", "applyPatch", "gather", "gather",
                        "askUser", "askUser", "commit", "commit"));

        // Gather → Reenter
        graph.addEdge("gather", "reenter");

        // Reenter → back to the originating node
        graph.addConditionalEdges("reenter",
                AsyncEdgeAction.edge_async(reenterAction::routeAfterReenter),
                Map.of("planning", "planning", "preCheck", "preCheck",
                        "generate", "generate", "repair", "repair"));

        // Commit → next phase or finalize
        graph.addConditionalEdges("commit",
                AsyncEdgeAction.edge_async(commitAction::routeAfterCommit),
                Map.of("preCheck", "preCheck", "finalize", "finalize"));

        // AskUser and Finalize are terminal
        graph.addEdge("askUser", StateGraph.END);
        graph.addEdge("finalize", StateGraph.END);

        return graph.compile();
    }

    /**
     * Deep Research graph topology:
     *
     * intake → planning(拆分研究子问题)
     * → [generate(产出搜索查询) → gather(执行搜索) → reenter → searchEvaluate
     *    → sufficient: commit / insufficient: 回到 generate]
     * → synthesize(汇总生成报告) → finalize
     */
    private CompiledGraph buildDeepResearchGraph() throws Exception {
        var graph = new StateGraph(IntakeAction::createStateWithStrategies);

        // Nodes
        graph.addNode("intake", AsyncNodeAction.node_async(intakeAction));
        graph.addNode("planning", AsyncNodeAction.node_async(planningAction));
        graph.addNode("generate", AsyncNodeAction.node_async(generateAction));
        graph.addNode("gather", AsyncNodeAction.node_async(gatherAction));
        graph.addNode("reenter", AsyncNodeAction.node_async(reenterAction));
        graph.addNode("searchEvaluate", AsyncNodeAction.node_async(searchEvaluateAction));
        graph.addNode("commit", AsyncNodeAction.node_async(commitAction));
        graph.addNode("synthesize", AsyncNodeAction.node_async(synthesizeAction));
        graph.addNode("askUser", AsyncNodeAction.node_async(askUserAction));
        graph.addNode("finalize", AsyncNodeAction.node_async(finalizeAction));

        // Edges
        graph.addEdge(StateGraph.START, "intake");
        graph.addEdge("intake", "planning");

        // Planning → generate first sub-question's search queries, or gather if need info first
        graph.addConditionalEdges("planning",
                AsyncEdgeAction.edge_async(planningAction::routeAfterPlanning),
                Map.of("preCheck", "generate", "gather", "gather", "finalize", "finalize"));

        // Generate → produce search queries, then gather
        graph.addConditionalEdges("generate",
                AsyncEdgeAction.edge_async(generateAction::routeAfterGenerate),
                Map.of("applyPatch", "gather", "gather", "gather", "askUser", "askUser"));

        // Gather → Reenter
        graph.addEdge("gather", "reenter");

        // Reenter → always go to searchEvaluate in deep-research mode
        graph.addEdge("reenter", "searchEvaluate");

        // SearchEvaluate → sufficient: commit / insufficient: generate more / askUser
        graph.addConditionalEdges("searchEvaluate",
                AsyncEdgeAction.edge_async(searchEvaluateAction::routeAfterEvaluate),
                Map.of("commit", "commit", "generate", "generate", "askUser", "askUser"));

        // Commit → next sub-question (generate) or all done (synthesize)
        graph.addConditionalEdges("commit",
                AsyncEdgeAction.edge_async(commitAction::routeAfterCommit),
                Map.of("preCheck", "generate", "finalize", "synthesize"));

        // Synthesize → finalize
        graph.addEdge("synthesize", "finalize");

        // Terminals
        graph.addEdge("askUser", StateGraph.END);
        graph.addEdge("finalize", StateGraph.END);

        return graph.compile();
    }
}