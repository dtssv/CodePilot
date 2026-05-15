package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.util.*;

/**
 * Helper that coordinates Shadow Workspace validation via the plugin client.
 * Since all code files reside on the client (IDE), Shadow Workspace validation
 * must be executed client-side. This helper:
 * 1. Emits a graph_shadow_validate SSE event with patch details
 * 2. Awaits the validation result via ToolResultBus
 * 3. Returns the validation result (pass/fail with errors)
 */
@Component
public class ShadowVerifyHelper {
    private static final Logger log = LoggerFactory.getLogger(ShadowVerifyHelper.class);
    private final ToolResultBus toolResultBus;

    public ShadowVerifyHelper(ToolResultBus toolResultBus) {
        this.toolResultBus = toolResultBus;
    }

    @SuppressWarnings("unchecked")
    public ValidationResult requestValidation(OverAllState state, String sessionId,
            List<Map<String, String>> patches) {
        if (patches.isEmpty()) {
            return new ValidationResult(true, List.of(), 0);
        }
        boolean shadowEnabled = (boolean) state.value("shadowValidationEnabled").orElse(true);
        if (!shadowEnabled) {
            log.debug("Shadow validation disabled by policy, skipping");
            return new ValidationResult(true, List.of(), 0);
        }

        String validateId = UUID.randomUUID().toString();
        long startTime = System.currentTimeMillis();

        // Register future BEFORE emitting SSE to avoid race condition
        var validateFuture = ToolResultBus.registerFuture(sessionId, validateId);
        GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
            "id", validateId,
            "name", "ide.shadowValidate",
            "args", Map.of("patches", patches, "validateType", "compile")
        ));

        try {
            ToolResultEvent result = validateFuture.get(60, java.util.concurrent.TimeUnit.SECONDS);
            long durationMs = System.currentTimeMillis() - startTime;
            if (result != null && result.ok()) {
                String output = result.result() != null ? result.result().toString() : "";
                var errors = parseValidationErrors(output);
                boolean passed = errors.isEmpty();
                log.info("Shadow validation: {} in {}ms (errors: {})",
                    passed ? "PASSED" : "FAILED", durationMs, errors.size());
                return new ValidationResult(passed, errors, durationMs);
            } else {
                String error = result != null ? result.errorMessage() : "Timeout";
                log.warn("Shadow validation failed: {}", error);
                return new ValidationResult(true, List.of(), durationMs);
            }
        } catch (Exception e) {
            log.warn("Shadow validation exception: {}", e.getMessage());
            return new ValidationResult(true, List.of(), System.currentTimeMillis() - startTime);
        }
    }

    private List<ValidationError> parseValidationErrors(String output) {
        if (output == null || output.isBlank()) return List.of();
        List<ValidationError> errors = new ArrayList<>();
        for (String line : output.split("\n")) {
            String[] parts = line.split(":", 3);
            if (parts.length >= 3) {
                errors.add(new ValidationError(parts[0].trim(),
                    parseIntSafe(parts[1].trim()), parts[2].trim(),
                    parts[2].toLowerCase().contains("error") ? "error" : "warning"));
            }
        }
        return errors;
    }

    private int parseIntSafe(String s) {
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return 0; }
    }

    public record ValidationResult(boolean passed, List<ValidationError> errors, long durationMs) {}
    public record ValidationError(String file, int line, String message, String severity) {}
}