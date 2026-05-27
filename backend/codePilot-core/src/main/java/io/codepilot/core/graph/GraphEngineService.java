package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.CompiledGraph;
import com.alibaba.cloud.ai.graph.StateGraph;
import com.alibaba.cloud.ai.graph.action.AsyncEdgeAction;
import com.alibaba.cloud.ai.graph.action.AsyncNodeAction;
import io.codepilot.core.conversation.SseFactory;
import io.codepilot.core.conversation.StopSignalBus;
import io.codepilot.core.deploy.DeployDrainService;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.run.GraphEngineProperties;
import io.codepilot.core.graph.GraphCheckpointStore;
import io.codepilot.core.graph.actions.*;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Graph-engine based conversation service using Spring AI Alibaba Graph (StateGraph).
 *
 * <p>Replaces the self-implemented GraphOrchestrator with Spring AI Alibaba's
 * declarative StateGraph API (Java port of LangGraph). The graph is compiled once
 * at startup and invoked per-request with the request state.
 *
 * <p>Key nodes: intake → planning → preCheck → generate → applyPatch → verify
 *   → commit/repair → summarize → finalize. Plus gather/reenter for info collection.
 *
 * <p>This service is called by {@link io.codepilot.core.conversation.ConversationService}
 * when {@code policy.engine == "graph"}.
 */
@Service
public class GraphEngineService {

    private static final Logger log = LoggerFactory.getLogger(GraphEngineService.class);

    private final Scheduler graphScheduler;

    private final IntakeAction intakeAction;
    private final IntentDispatchAction intentDispatchAction;
    private final MemoryLoadAction memoryLoadAction;
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
    private final SummarizeAction summarizeAction;
    private final DynamicPlanExpandAction dynamicPlanExpandAction;
    private final ContextSplitAction contextSplitAction;
    private final SseFactory sse;
    private final GraphCheckpointStore checkpointStore;
    private final StopSignalBus stopBus;
    private final DeployDrainService deployDrainService;

    public GraphEngineService(
            IntakeAction intakeAction,
            IntentDispatchAction intentDispatchAction,
            MemoryLoadAction memoryLoadAction,
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
            SummarizeAction summarizeAction,
            DynamicPlanExpandAction dynamicPlanExpandAction,
            ContextSplitAction contextSplitAction,
            SseFactory sse,
            GraphCheckpointStore checkpointStore,
            StopSignalBus stopBus,
            DeployDrainService deployDrainService,
            GraphEngineProperties graphProperties) {
        int threadCap =
                graphProperties.getSchedulerThreadCap() > 0
                        ? graphProperties.getSchedulerThreadCap()
                        : Schedulers.DEFAULT_BOUNDED_ELASTIC_SIZE;
        int queueSize =
                graphProperties.getSchedulerQueueSize() > 0
                        ? graphProperties.getSchedulerQueueSize()
                        : Schedulers.DEFAULT_BOUNDED_ELASTIC_QUEUESIZE;
        this.graphScheduler =
                Schedulers.newBoundedElastic(threadCap, queueSize, "graph-engine", 60, true);
        this.intakeAction = intakeAction;
        this.intentDispatchAction = intentDispatchAction;
        this.memoryLoadAction = memoryLoadAction;
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
        this.summarizeAction = summarizeAction;
        this.dynamicPlanExpandAction = dynamicPlanExpandAction;
        this.contextSplitAction = contextSplitAction;
        this.sse = sse;
        this.checkpointStore = checkpointStore;
        this.stopBus = stopBus;
        this.deployDrainService = deployDrainService;
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
            String sid = req.sessionId();
            GraphExecutionLog.runStart(
                sid,
                String.valueOf(initialState.value("mode").orElse("AGENT")),
                req.input());
            log.info("GraphEngine initial state: modelId={}, modelSource={}, userId={}, keys={}",
                initialState.value("modelId").orElse(null),
                initialState.value("modelSource").orElse(null),
                initialState.value("userId").orElse(null),
                initialState.keyStrategies().keySet());

            Sinks.Many<ServerSentEvent<String>> liveSink = Sinks.many().unicast().onBackpressureBuffer();
            Runnable graphTask = () -> {
                GraphSseHelper.setLiveSink(liveSink, sse);
                GraphSseHelper.registerSessionSink(sid, liveSink, sse);
                AtomicBoolean stopHandled = new AtomicBoolean(false);
                Disposable stopSub =
                    stopBus
                        .subscribe(sid)
                        .take(1)
                        .subscribe(
                            msg -> {
                              if (stopHandled.compareAndSet(false, true)) {
                                if (!deployDrainService.isDraining()) {
                                  liveSink.tryEmitNext(
                                      sse.event(SseEvents.DONE, Map.of("reason", "stopped")));
                                }
                                liveSink.tryEmitComplete();
                              }
                            });
                try {
                    var resultState = graph.invoke(initialState.data());
                    log.info("GraphEngine completed: state keys={}",
                        resultState.map(s -> s.data().keySet()).orElse(null));
                    GraphExecutionLog.runEnd(sid, "completed", resultState.map(s -> s.data().keySet()).orElse(null));
                    liveSink.tryEmitComplete();
                } catch (Exception e) {
                    GraphInterruptException gie = unwrapGraphInterrupt(e);
                    if (gie != null) {
                        log.info("GraphEngine interrupted: reason={}, token={}", gie.getReason(), gie.getContinuationToken());
                    } else {
                        log.error("Graph engine execution failed", e);
                        liveSink.tryEmitNext(
                                sse.error(
                                        io.codepilot.common.api.ErrorCodes.UPSTREAM_MODEL,
                                        "当前请求处理失败，请稍后重试。若问题持续出现，请联系运营人员排查。"));
                    }
                    liveSink.tryEmitComplete();
                } finally {
                    stopSub.dispose();
                    GraphSseHelper.clearLiveSink();
                    GraphSseHelper.unregisterSessionSink(sid);
                }
            };
            graphScheduler.schedule(graphTask);

            return liveSink.asFlux();
        } catch (Exception e) {
            log.error("Graph engine execution failed", e);
            return Flux.just(
                    sse.error(
                            io.codepilot.common.api.ErrorCodes.UPSTREAM_MODEL,
                            "当前请求处理失败，请稍后重试。若问题持续出现，请联系运营人员排查。"),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
        }
    }

    /**
     * Resumes a previously interrupted graph execution from a checkpoint.
     *
     * <p>Loads the saved state snapshot from Redis using the continuationToken,
     * merges any user answers, then re-invokes the graph starting from the
     * interrupt point's next node.
     *
     * @param req              the resume request with continuationToken and answers
     * @param userId           the user ID
     * @return SSE event stream continuing from the interrupt point
     */
    public Flux<ServerSentEvent<String>> resume(ConversationRunRequest req, String userId) {
        String continuationToken = req.continuationToken();
        if (continuationToken == null || continuationToken.isBlank()) {
            return Flux.just(
                    sse.error(50002, "Missing continuationToken for resume"),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
        }

        Sinks.Many<ServerSentEvent<String>> liveSink = Sinks.many().unicast().onBackpressureBuffer();

        // Load checkpoint asynchronously, then resume graph execution
        checkpointStore.load(continuationToken)
                .subscribe(snapshot -> {
                    if (snapshot == null) {
                        liveSink.tryEmitNext(sse.error(50002,
                                "Checkpoint not found or expired for token: " + continuationToken));
                        liveSink.tryEmitComplete();
                        return;
                    }

                    try {
                        String template = req.policy() != null && req.policy().graphTemplate() != null
                                ? req.policy().graphTemplate() : "default";
                        var graph = "deep-research".equals(template) ? buildDeepResearchGraph() : buildGraph();

                        // Restore state from checkpoint and merge answers
                        var restoredState = IntakeAction.restoreFromCheckpoint(snapshot, req, userId);

                        log.info("GraphEngine resume: token={}, nextNode={}, restoredStateKeys={}",
                                continuationToken, snapshot.nextNode(), restoredState.data().keySet());

                        // Schedule graph execution on dedicated scheduler
                        // ★ Register session sink INSIDE the scheduled task (same pattern as run())
                        // to ensure the sink is available before graph.invoke() starts emitting.
                        String sid = req.sessionId();
                        graphScheduler.schedule(() -> {
                            GraphSseHelper.setLiveSink(liveSink, sse);
                            GraphSseHelper.registerSessionSink(sid, liveSink, sse);
                            AtomicBoolean stopHandled = new AtomicBoolean(false);
                            Disposable stopSub =
                                stopBus
                                    .subscribe(sid)
                                    .take(1)
                                    .subscribe(
                                        msg -> {
                                          if (stopHandled.compareAndSet(false, true)) {
                                            if (!deployDrainService.isDraining()) {
                                              liveSink.tryEmitNext(
                                                  sse.event(SseEvents.DONE, Map.of("reason", "stopped")));
                                            }
                                            liveSink.tryEmitComplete();
                                          }
                                        });
                            try {
                                var resultState = graph.invoke(restoredState.data());
                                log.info("GraphEngine resume completed: state keys={}",
                                        resultState.map(s -> s.data().keySet()).orElse(null));
                                liveSink.tryEmitComplete();
                            } catch (Exception e) {
                                GraphInterruptException gie = unwrapGraphInterrupt(e);
                                if (gie != null) {
                                    log.info("GraphEngine resume interrupted: reason={}, token={}", gie.getReason(), gie.getContinuationToken());
                                } else {
                                    log.error("Graph engine resume execution failed", e);
                                    liveSink.tryEmitNext(sse.error(50001, "Graph engine resume error: " + e.getMessage()));
                                }
                                liveSink.tryEmitComplete();
                            } finally {
                                stopSub.dispose();
                                GraphSseHelper.clearLiveSink();
                                GraphSseHelper.unregisterSessionSink(sid);
                            }
                        });

                        // Clean up checkpoint after successful resume initiation
                        checkpointStore.remove(continuationToken).subscribe();

                    } catch (Exception e) {
                        log.error("Graph engine resume setup failed", e);
                        liveSink.tryEmitNext(sse.error(50001, "Graph engine resume error: " + e.getMessage()));
                        liveSink.tryEmitComplete();
                    }
                }, error -> {
                    log.error("Failed to load checkpoint for token={}", continuationToken, error);
                    liveSink.tryEmitNext(sse.error(50002, "Failed to load checkpoint: " + error.getMessage()));
                    liveSink.tryEmitComplete();
                });

        return liveSink.asFlux();
    }

    private CompiledGraph buildGraph() throws Exception {
        var graph = new StateGraph(IntakeAction::keyStrategies);

        // ── Define Nodes ──
        graph.addNode("intake", AsyncNodeAction.node_async(intakeAction));
        graph.addNode("memoryLoad", AsyncNodeAction.node_async(memoryLoadAction));
        graph.addNode("intentDispatch", AsyncNodeAction.node_async(intentDispatchAction));
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
        graph.addNode("summarize", AsyncNodeAction.node_async(summarizeAction));
        graph.addNode("finalize", AsyncNodeAction.node_async(finalizeAction));
        graph.addNode("dynamicPlanExpand", AsyncNodeAction.node_async(dynamicPlanExpandAction));
        graph.addNode("contextSplit", AsyncNodeAction.node_async(contextSplitAction));

        // ── Define Edges ──
        graph.addEdge(StateGraph.START, "intake");

        // Intake: on fresh run goes to contextSplit (which splits large context then routes to memoryLoad);
        // on resume (has resumeNextNode) jumps to the target node, skipping contextSplit
        graph.addConditionalEdges("intake",
                AsyncEdgeAction.edge_async(intakeAction::routeAfterIntake),
                Map.of("planning", "contextSplit", "preCheck", "contextSplit",
                        "generate", "contextSplit", "applyPatch", "contextSplit",
                        "repair", "contextSplit", "gather", "contextSplit",
                        "askUser", "contextSplit", "verify", "contextSplit",
                        "commit", "contextSplit", "intentDispatch", "contextSplit"));

        // contextSplit: always routes to memoryLoad after splitting large context
        graph.addConditionalEdges("contextSplit",
                AsyncEdgeAction.edge_async(contextSplitAction::routeAfterContextSplit),
                Map.of("memoryLoad", "memoryLoad"));

        // MemoryLoad: routes to planning/intentDispatch/generate based on mode and intent;
        // on resume from askUser checkpoint, routes directly to the checkpoint's target node
        // (e.g. "generate") to preserve the previous plan and execution context.
        graph.addConditionalEdges("memoryLoad",
                AsyncEdgeAction.edge_async(memoryLoadAction::routeAfterMemoryLoad),
                Map.of("planning", "planning", "generate", "generate",
                        "intentDispatch", "intentDispatch",
                        "preCheck", "preCheck", "applyPatch", "applyPatch",
                        "repair", "repair", "gather", "gather",
                        "askUser", "askUser", "verify", "verify",
                        "commit", "commit"));

        // IntentDispatch → always summarize (short-circuit path, then finalize)
        graph.addConditionalEdges("intentDispatch",
                AsyncEdgeAction.edge_async(intentDispatchAction::routeAfterIntentDispatch),
                Map.of("summarize", "summarize"));

        // Planning → may need info or proceed to phase loop
        graph.addConditionalEdges("planning",
                AsyncEdgeAction.edge_async(planningAction::routeAfterPlanning),
                Map.of("preCheck", "preCheck", "gather", "gather", "summarize", "summarize"));

        // PreCheck → may need info (gather), be blocked (askUser), or proceed (generate)
        graph.addConditionalEdges("preCheck",
                AsyncEdgeAction.edge_async(preCheckAction::routeAfterPreCheck),
                Map.of("generate", "generate", "gather", "gather", "askUser", "askUser"));

        // Generate → may need info, produce toolCalls, or textOutput (B3: skip applyPatch)
        graph.addConditionalEdges("generate",
                AsyncEdgeAction.edge_async(generateAction::routeAfterGenerate),
                Map.of("applyPatch", "applyPatch", "gather", "gather",
                        "askUser", "askUser", "commit", "commit",
                        "reenter", "reenter", "repair", "repair",
                        "summarize", "summarize"));

        // ApplyPatch → may succeed or fail; fast-path can skip verify (C1)
        graph.addConditionalEdges("applyPatch",
                AsyncEdgeAction.edge_async(applyPatchAction::routeAfterApplyPatch),
                Map.of("verify", "verify", "repair", "repair", "commit", "commit"));

        // Verify → success/fail/uncertain
        graph.addConditionalEdges("verify",
                AsyncEdgeAction.edge_async(verifyAction::routeAfterVerify),
                Map.of("commit", "commit", "repair", "repair", "askUser", "askUser"));

        // Repair → may need info, retry verify, partial commit (M3), or retry with different tool calls
        graph.addConditionalEdges("repair",
                AsyncEdgeAction.edge_async(repairAction::routeAfterRepair),
                Map.of("applyPatch", "applyPatch", "askUser", "askUser",
                        "commit", "commit", "generate", "generate"));

        // Gather → Reenter
        graph.addEdge("gather", "reenter");

        // Reenter → back to the originating node
        graph.addConditionalEdges("reenter",
                AsyncEdgeAction.edge_async(reenterAction::routeAfterReenter),
                Map.of("planning", "planning", "preCheck", "preCheck",
                        "generate", "generate", "repair", "repair"));

        // Commit → next phase, summarize (then finalize), or repair (when phaseCommitBlocked)
        graph.addConditionalEdges("commit",
                AsyncEdgeAction.edge_async(commitAction::routeAfterCommit),
                Map.of(
                        "preCheck",
                        "preCheck",
                        "dynamicPlanExpand",
                        "dynamicPlanExpand",
                        "summarize",
                        "summarize",
                        "retryGenerate",
                        "generate",
                        "repair",
                        "repair"));

        // AskUser: can route to a target node (resume after user answers) or END (terminal)
        graph.addConditionalEdges("askUser",
                AsyncEdgeAction.edge_async(askUserAction::routeAfterAskUser),
                Map.of("repair", "repair", "generate", "generate",
                        "planning", "planning", "preCheck", "preCheck",
                        "verify", "verify", "gather", "gather",
                        "commit", "commit", "summarize", "summarize"));

        // Summarize → finalize (summarize runs before finalize to produce change digest)
        graph.addEdge("summarize", "finalize");

        // DynamicPlanExpand → preCheck (start new micro-phases) or summarize (all done)
        graph.addConditionalEdges("dynamicPlanExpand",
                AsyncEdgeAction.edge_async(dynamicPlanExpandAction::routeAfterDynamicPlanExpand),
                Map.of("preCheck", "preCheck", "summarize", "summarize"));

        graph.addEdge("finalize", StateGraph.END);

        return graph.compile();
    }

    /**
     * Deep Research graph topology:
     *
     * intake → planning(拆分研究子问题)
     * → [generate(产出搜索查询) → gather(执行搜索) → reenter → searchEvaluate
     *    → sufficient: commit / insufficient: 回到 generate]
     * → synthesize(汇总生成报告) → summarize(改动总结) → finalize
     */
    private CompiledGraph buildDeepResearchGraph() throws Exception {
        var graph = new StateGraph(IntakeAction::keyStrategies);

        // Nodes
        graph.addNode("intake", AsyncNodeAction.node_async(intakeAction));
        graph.addNode("memoryLoad", AsyncNodeAction.node_async(memoryLoadAction));
        graph.addNode("intentDispatch", AsyncNodeAction.node_async(intentDispatchAction));
        graph.addNode("planning", AsyncNodeAction.node_async(planningAction));
        graph.addNode("preCheck", AsyncNodeAction.node_async(preCheckAction));
        graph.addNode("generate", AsyncNodeAction.node_async(generateAction));
        graph.addNode("gather", AsyncNodeAction.node_async(gatherAction));
        graph.addNode("reenter", AsyncNodeAction.node_async(reenterAction));
        graph.addNode("searchEvaluate", AsyncNodeAction.node_async(searchEvaluateAction));
        graph.addNode("commit", AsyncNodeAction.node_async(commitAction));
        graph.addNode("synthesize", AsyncNodeAction.node_async(synthesizeAction));
        graph.addNode("askUser", AsyncNodeAction.node_async(askUserAction));
        graph.addNode("summarize", AsyncNodeAction.node_async(summarizeAction));
        graph.addNode("finalize", AsyncNodeAction.node_async(finalizeAction));
        graph.addNode("dynamicPlanExpand", AsyncNodeAction.node_async(dynamicPlanExpandAction));
        graph.addNode("contextSplit", AsyncNodeAction.node_async(contextSplitAction));
        // Repair node — same as main graph, supports retryGenerate → generate
        graph.addNode("repair", AsyncNodeAction.node_async(repairAction));

        // Edges
        graph.addEdge(StateGraph.START, "intake");

        // Intake: fresh run → contextSplit (large input) then memoryLoad; resume jumps to target
        graph.addConditionalEdges("intake",
                AsyncEdgeAction.edge_async(intakeAction::routeAfterIntake),
                Map.of("planning", "contextSplit", "generate", "contextSplit",
                        "gather", "contextSplit", "askUser", "contextSplit",
                        "repair", "contextSplit", "verify", "contextSplit",
                        "intentDispatch", "contextSplit"));

        graph.addConditionalEdges("contextSplit",
                AsyncEdgeAction.edge_async(contextSplitAction::routeAfterContextSplit),
                Map.of("memoryLoad", "memoryLoad"));

        // MemoryLoad → planning/intentDispatch/generate based on mode
        graph.addConditionalEdges("memoryLoad",
                AsyncEdgeAction.edge_async(memoryLoadAction::routeAfterMemoryLoad),
                Map.of("planning", "planning", "generate", "generate",
                        "intentDispatch", "intentDispatch"));

        // Planning → generate first sub-question's search queries, or gather if need info first
        graph.addConditionalEdges("planning",
                AsyncEdgeAction.edge_async(planningAction::routeAfterPlanning),
                Map.of("preCheck", "generate", "gather", "gather", "summarize", "summarize"));

        // IntentDispatch → always summarize (short-circuit path, then finalize)
        graph.addConditionalEdges("intentDispatch",
                AsyncEdgeAction.edge_async(intentDispatchAction::routeAfterIntentDispatch),
                Map.of("summarize", "summarize"));

        // Generate → produce search queries, then gather; may also route to repair/reenter/commit/summarize
        graph.addConditionalEdges("generate",
                AsyncEdgeAction.edge_async(generateAction::routeAfterGenerate),
                Map.of("applyPatch", "gather", "gather", "gather",
                        "askUser", "askUser", "commit", "commit",
                        "reenter", "reenter", "repair", "repair",
                        "summarize", "summarize"));

        // Gather → Reenter
        graph.addEdge("gather", "reenter");

        // Reenter → always go to searchEvaluate in deep-research mode
        graph.addEdge("reenter", "searchEvaluate");

        // SearchEvaluate → sufficient: commit / insufficient: generate more / askUser
        graph.addConditionalEdges("searchEvaluate",
                AsyncEdgeAction.edge_async(searchEvaluateAction::routeAfterEvaluate),
                Map.of("commit", "commit", "generate", "generate", "askUser", "askUser"));

        // Commit → next sub-question (generate), all done (synthesize), or repair (when phaseCommitBlocked)
        // Also supports hierarchical planning: dynamicPlanExpand for macro-phase transitions
        graph.addConditionalEdges("commit",
                AsyncEdgeAction.edge_async(commitAction::routeAfterCommit),
                Map.of("preCheck", "generate", "summarize", "synthesize",
                        "retryGenerate", "generate", "repair", "repair",
                        "dynamicPlanExpand", "dynamicPlanExpand"));

        // Repair → applyPatch, askUser, commit, or retryGenerate (retry tool calls via generate)
        graph.addConditionalEdges("repair",
                AsyncEdgeAction.edge_async(repairAction::routeAfterRepair),
                Map.of("applyPatch", "gather", "askUser", "askUser",
                        "commit", "commit", "generate", "generate"));

        // Synthesize → summarize → finalize
        graph.addEdge("synthesize", "summarize");

        // AskUser: can route to a target node (resume after user answers) or END
        graph.addConditionalEdges("askUser",
                AsyncEdgeAction.edge_async(askUserAction::routeAfterAskUser),
                Map.of("repair", "repair", "generate", "generate",
                        "planning", "planning", "preCheck", "preCheck",
                        "verify", "verify", "gather", "gather",
                        "commit", "commit", "summarize", "summarize"));

        // Summarize → finalize (summarize runs before finalize to produce change digest)
        graph.addEdge("summarize", "finalize");

        // Terminals
        graph.addEdge("finalize", StateGraph.END);

        return graph.compile();
    }

    /**
     * Unwraps a {@link GraphInterruptException} from the cause chain of an exception.
     *
     * <p>Spring AI Alibaba's {@code CompiledGraph.invoke()} wraps node exceptions in
     * {@code ExecutionException} → {@code CompletionException}, so a direct
     * {@code catch (GraphInterruptException)} never matches. This helper traverses
     * the cause chain to find the controlled interrupt.
     *
     * @return the {@code GraphInterruptException} if found in the cause chain, otherwise null
     */
    private static GraphInterruptException unwrapGraphInterrupt(Throwable e) {
        Throwable current = e;
        while (current != null) {
            if (current instanceof GraphInterruptException gie) {
                return gie;
            }
            current = current.getCause();
        }
        return null;
    }
}