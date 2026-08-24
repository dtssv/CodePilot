package io.codepilot.core.model;

import java.util.List;

/**
 * Backend ChatModel SPI — server-side mirror of harness-core's
 * {@code io.codepilot.harness.model.ChatModel}.
 *
 * <p>Per ADR-1, the backend degenerates to a Model Gateway: it forwards
 * LLM calls (auth, routing, quota) and emits ModelEvents over the wire.
 * The plugin-side AgentHarness depends on this SPI (via the gateway HTTP
 * transport) instead of calling Spring AI directly.
 *
 * <p>Implementations live in {@code core.model.adapters}:
 * OpenAi, Anthropic, DashScope.
 */
public interface ChatModel {

    /** Model identifier, e.g. "gpt-4o" / "claude-3-7-sonnet" / "qwen-max". */
    String name();

    /**
     * Stream a chat completion. Emits ModelEvents in order:
     * zero or more TextDelta / AssistantToolCall, exactly one StopReason.
     * The publisher MUST be cold — subscribed only when the gateway
     * forwards the request.
     */
    reactor.core.publisher.Flux<ModelEvent> stream(ChatRequest request);

    /** Factory: select an adapter by model name. */
    interface Provider {
        ChatModel forName(String model);
    }
}
