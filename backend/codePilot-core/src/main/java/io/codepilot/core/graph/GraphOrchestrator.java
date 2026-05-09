package io.codepilot.core.graph;

import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.nodes.*;
import io.codepilot.core.graph.policies.BudgetGuard;
import io.codepilot.core.graph.sse.GraphSseEmitter;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.util.Map;

/**
 * Central dispatcher for the Graph engine.
 * Drives the state machine: loads/inits GraphState, iterates nodes,
 * handles EdgeDecisions (Go/Retry/Gather/AskUser/Await/Done),
 * and emits SSE events via {@link GraphSseEmitter}.
 *
 * <p>A single /conversation/run only advances until a natural pause:
 * askUser, awaitUserInput, commit(last-phase), budgetExceeded, or final.</p>
 */
@Component
public class GraphOrchestrator {

    private final GraphStateStore stateStore;
    private final GraphNodeRegistry nodeRegistry;
    private final BudgetGuard budgetGuard;
    private final GraphSseEmitter sseEmitter;

    public GraphOrchestrator(GraphStateStore stateStore,
                             GraphNodeRegistry nodeRegistry,
                             BudgetGuard budgetGuard,
                             GraphSseEmitter sseEmitter) {
        this.stateStore = stateStore;
        this.nodeRegistry = nodeRegistry;
        this.budgetGuard = budgetGuard;
        this.sseEmitter = sseEmitter;
    }

    /**
     * Main entry point. Returns a reactive stream of AgentEvent (SSE payloads).
     */
    public Flux<Map<String, Object>> run(ConversationRunRequest request) {
        return Flux.create(sink -> {
            GraphState state = stateStore.loadOrInit(request);
            executeLoop(state, request, sink);
        });
    }

    private void executeLoop(GraphState state, ConversationRunRequest request, FluxSink<Map<String, Object>> sink) {
        int maxIterations = 100; // safety guard
        int iteration = 0;

        while (iteration++ < maxIterations) {
            String currentNodeId = state.getCurrentNode();
            GraphNode node = nodeRegistry.get(currentNodeId);
            if (node == null) {
                sink.next(sseEmitter.error("unknown_node", "No handler for node: " + currentNodeId));
                sink.next(sseEmitter.done("failed"));
                sink.complete();
                return;
            }

            NodeResult result = node.execute(state, request, sink);
            sink.next(sseEmitter.transition(currentNodeId, result.nextNode(), state.getPhaseCursor(), result.reason()));

            EdgeDecision decision = result.decision();

            switch (decision) {
                case EdgeDecision.Go go -> state.moveTo(go.nextNode());

                case EdgeDecision.Retry retry -> {
                    state.incrementAttempt();
                    state.moveTo(currentNodeId); // stay on same node
                }

                case EdgeDecision.Gather gather -> {
                    state.setGatherRequest(gather.requests(), gather.resumeTo());
                    state.moveTo("gather");
                }

                case EdgeDecision.AskUser askUser -> {
                    state.setAwaiting(askUser.needsInput(), askUser.nextNode());
                    sink.next(sseEmitter.needsInput(askUser.needsInput()));
                    sink.next(sseEmitter.done("awaiting_user_input"));
                    stateStore.save(request.sessionId(), state);
                    sink.complete();
                    return;
                }

                case EdgeDecision.Await await -> {
                    sink.next(sseEmitter.done(await.reason(), await.continuationToken()));
                    stateStore.save(request.sessionId(), state);
                    sink.complete();
                    return;
                }

                case EdgeDecision.Done done -> {
                    sink.next(sseEmitter.done(done.reason()));
                    stateStore.save(request.sessionId(), state);
                    sink.complete();
                    return;
                }
            }

            // Budget check after each step
            if (!budgetGuard.allow(state)) {
                sink.next(sseEmitter.budgetAlert(state.getPhaseCursor(),
                        budgetGuard.violatedKind(state),
                        budgetGuard.currentValue(state),
                        budgetGuard.limit(state)));
                state.moveTo("askUser");
            }

            // Persist checkpoint after each step
            stateStore.save(request.sessionId(), state);
        }

        // Exhausted max iterations
        sink.next(sseEmitter.done("max_steps"));
        stateStore.save(request.sessionId(), state);
        sink.complete();
    }
}