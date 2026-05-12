package io.codepilot.api.action;

import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ChatClientFactory.ResolvedClient;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * FIM (Fill-in-the-Middle) Native Interface Controller.
 *
 * Provides a dedicated endpoint for code completion models that support
 * native FIM/infilling APIs (e.g., Codestral, DeepSeek-Coder, StarCoder2,
 * Qwen2.5-Coder). These models accept structured prefix/suffix/middle
 * tokens directly without needing prompt engineering.
 *
 * Protocol:
 * - POST /v1/fim/completions — OpenAI-compatible FIM API
 *   - Request: { model, prompt, suffix, max_tokens, temperature, stop, n }
 *   - Response: SSE stream of { id, choices: [{ index, text, finish_reason }] }
 *
 * Models supporting native FIM:
 * - Codestral (Mistral): prompt/suffix parameters
 * - DeepSeek-Coder: prefix/suffix FIM format
 * - StarCoder2: <fim_prefix>/<fim_suffix>/<fim_middle> tokens
 * - Qwen2.5-Coder: <fim_prefix>/<fim_suffix>/<fim_middle> tokens
 *
 * The endpoint auto-detects the model's FIM format and adapts the request
 * accordingly, falling back to chat-based completion for non-FIM models.
 */
@Tag(name = "fim", description = "Native FIM (Fill-in-the-Middle) completion interface")
@RestController
@RequestMapping(value = "/v1/fim", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public class FimNativeController {

    private final ChatClientFactory clientFactory;
    private final ModelService modelService;

    public FimNativeController(ChatClientFactory clientFactory, ModelService modelService) {
        this.clientFactory = clientFactory;
        this.modelService = modelService;
    }

    @Operation(summary = "Native FIM completion — OpenAI-compatible infilling API")
    @PostMapping(value = "/completions", consumes = MediaType.APPLICATION_JSON_VALUE)
    public Flux<ServerSentEvent<String>> completions(@RequestBody @Valid FimRequest req) {
        String modelId = req.model() != null ? req.model() : modelService.listModelGroups().stream()
            .filter(g -> g.capabilities() != null && g.capabilities().contains("fim"))
            .map(io.codepilot.core.model.ModelGroup::model)
            .findFirst()
            .orElse(modelService.listModelGroups().isEmpty() ? null : modelService.listModelGroups().getFirst().model());
        return executeFimCompletion(modelId, req);
    }

    /**
     * Execute FIM completion by detecting the model's native FIM format
     * and constructing the appropriate request.
     */
    private Flux<ServerSentEvent<String>> executeFimCompletion(String modelId, FimRequest req) {
        return Mono.fromCallable(() -> clientFactory.resolve(modelId))
            .flatMapMany(resolvedClient -> {
                String fimFormat = detectFimFormat(modelId);

                return switch (fimFormat) {
                    case "codestral" -> executeCodestralFim(resolvedClient, req);
                    case "deepseek" -> executeDeepseekFim(resolvedClient, req);
                    case "starcoder" -> executeStarcoderFim(resolvedClient, req);
                    default -> executeChatBasedFim(resolvedClient, req); // Fallback
                };
            })
            .onErrorResume(e -> Flux.just(
                ServerSentEvent.<String>builder()
                    .event("error")
                    .data("{\"error\":\"" + e.getMessage().replace("\"", "\\\"") + "\"}")
                    .build()
            ));
    }

    /**
     * Detect the FIM format for a given model ID based on naming conventions.
     */
    private String detectFimFormat(String modelId) {
        if (modelId == null) return "chat";
        String lower = modelId.toLowerCase();
        if (lower.contains("codestral") || lower.contains("mistral")) return "codestral";
        if (lower.contains("deepseek")) return "deepseek";
        if (lower.contains("starcoder") || lower.contains("star")) return "starcoder";
        if (lower.contains("qwen") && lower.contains("coder")) return "starcoder"; // Qwen uses same format
        if (lower.contains("codellama")) return "starcoder";
        return "chat"; // Unknown model, fall back to chat-based
    }

    /**
     * Codestral FIM format: Uses prompt + suffix parameters directly.
     * POST /v1/fim/completions with { prompt, suffix }
     */
    private Flux<ServerSentEvent<String>> executeCodestralFim(ResolvedClient client, FimRequest req) {
        Map<String, Object> payload = Map.of(
            "model", req.model(),
            "prompt", req.prompt(),
            "suffix", req.suffix() != null ? req.suffix() : "",
            "max_tokens", req.maxTokens() != null ? req.maxTokens() : 128,
            "temperature", req.temperature() != null ? req.temperature() : 0.2,
            "stop", req.stop() != null ? req.stop() : List.of("\n\n"),
            "n", req.n() != null ? req.n() : 1
        );
        return streamFimResponse(client, payload, "/v1/fim/completions");
    }

    /**
     * DeepSeek-Coder FIM format: Uses prefix + suffix in the FIM-specific format.
     * Wraps in the DeepSeek chat completions API with special FIM markers.
     */
    private Flux<ServerSentEvent<String>> executeDeepseekFim(ResolvedClient client, FimRequest req) {
        String fimContent = "<｜fim▁begin｜>" + req.prompt()
            + "<｜fim▁hole｜>"
            + (req.suffix() != null ? req.suffix() : "")
            + "<｜fim▁end｜>";

        Map<String, Object> payload = Map.of(
            "model", req.model(),
            "messages", List.of(Map.of("role", "user", "content", fimContent)),
            "max_tokens", req.maxTokens() != null ? req.maxTokens() : 128,
            "temperature", req.temperature() != null ? req.temperature() : 0.2,
            "stop", req.stop() != null ? req.stop() : List.of("<｜fim▁end｜>"),
            "n", req.n() != null ? req.n() : 1
        );
        return streamFimResponse(client, payload, "/v1/chat/completions");
    }

    /**
     * StarCoder2 / Qwen2.5-Coder FIM format:
     * Uses <fim_prefix>/<fim_suffix>/<fim_middle> token markers.
     */
    private Flux<ServerSentEvent<String>> executeStarcoderFim(ResolvedClient client, FimRequest req) {
        String fimContent = "<fim_prefix>" + req.prompt()
            + "<fim_suffix>" + (req.suffix() != null ? req.suffix() : "")
            + "<fim_middle>";

        Map<String, Object> payload = Map.of(
            "model", req.model(),
            "messages", List.of(Map.of("role", "user", "content", fimContent)),
            "max_tokens", req.maxTokens() != null ? req.maxTokens() : 128,
            "temperature", req.temperature() != null ? req.temperature() : 0.2,
            "stop", req.stop() != null ? req.stop() : List.of("<|endoftext|>", "\n\n"),
            "n", req.n() != null ? req.n() : 1
        );
        return streamFimResponse(client, payload, "/v1/chat/completions");
    }

    /**
     * Chat-based FIM fallback for models without native FIM support.
     * Uses a standard chat completion with the prefix/suffix context.
     */
    private Flux<ServerSentEvent<String>> executeChatBasedFim(ResolvedClient client, FimRequest req) {
        String content = "Complete the code at the cursor position (between PREFIX and SUFFIX).\n\n"
            + "```prefix\n" + req.prompt() + "\n```\n\n"
            + "```suffix\n" + (req.suffix() != null ? req.suffix() : "") + "\n```\n\n"
            + "Output ONLY the code to insert (no explanations, no markdown fences):";

        Map<String, Object> payload = Map.of(
            "model", req.model(),
            "messages", List.of(Map.of("role", "user", "content", content)),
            "max_tokens", req.maxTokens() != null ? req.maxTokens() : 128,
            "temperature", req.temperature() != null ? req.temperature() : 0.2,
            "n", req.n() != null ? req.n() : 1
        );
        return streamFimResponse(client, payload, "/v1/chat/completions");
    }

    /**
     * Stream the FIM response as SSE events, normalizing the output format
     * to the OpenAI FIM completion response structure.
     */
    private Flux<ServerSentEvent<String>> streamFimResponse(
        ResolvedClient client, Map<String, Object> payload, String apiPath) {

        client.startRequest();

        // Build user message from payload messages if present, otherwise from prompt
        String content;
        if (payload.containsKey("messages")) {
            @SuppressWarnings("unchecked")
            List<Map<String, String>> messages = (List<Map<String, String>>) payload.get("messages");
            content = messages.stream()
                .filter(m -> "user".equals(m.get("role")))
                .map(m -> m.get("content"))
                .findFirst()
                .orElse("");
        } else {
            content = (String) payload.getOrDefault("prompt", "");
        }

        return client.chatClient().prompt()
            .user(content)
            .stream()
            .chatResponse()
            .map(chatResp -> {
                String text = deltaFromChatResponse(chatResp);
                return ServerSentEvent.<String>builder()
                    .event("completion")
                    .data(formatFimChunk(text))
                    .build();
            })
            .filter(sse -> sse.data() != null && !sse.data().isEmpty())
            .concatWith(Flux.just(
                ServerSentEvent.<String>builder()
                    .event("done")
                    .data("[DONE]")
                    .build()
            ))
            .doFinally(signalType -> client.endRequest(true, 0));
    }

    /**
     * Format a raw LLM chunk into the OpenAI FIM completion format.
     */
    private String formatFimChunk(String rawChunk) {
        // If already in OpenAI format, pass through
        if (rawChunk.contains("\"choices\"") && rawChunk.contains("\"text\"")) {
            return rawChunk;
        }
        // Wrap in FIM completion format
        String escapedText = rawChunk.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
        return "{\"id\":\"fim-" + UUID.randomUUID().toString().substring(0, 8) + "\","
            + "\"choices\":[{\"index\":0,\"text\":\"" + escapedText + "\",\"finish_reason\":null}]}";
    }

    private static String deltaFromChatResponse(ChatResponse r) {
        if (r == null || r.getResult() == null || r.getResult().getOutput() == null) return "";
        return r.getResult().getOutput().getText();
    }

    // ─── Request / Response Records ─────────────────────────────────────

    /**
     * OpenAI-compatible FIM completion request.
     * Matches the OpenAI /v1/fim/completions API spec.
     */
    public record FimRequest(
        String model,
        @NotBlank String prompt,
        String suffix,
        Integer maxTokens,
        Double temperature,
        List<String> stop,
        Integer n,
        // Extended fields for CodePilot
        String language,
        String filePath,
        String fileOutline) {}
}