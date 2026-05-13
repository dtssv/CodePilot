package io.codepilot.core.graph.gather;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Validates info requests before execution by the Gather node.
 * Ensures only read-only operations are allowed and args are within bounds.
 */
@Component
public class InfoRequestValidator {

    private static final Set<String> ALLOWED_KINDS = Set.of(
            "fs.read", "fs.list", "fs.grep",
            "code.outline", "code.symbol", "code.usages",
            "shell.exec", "rag.search", "mcp.call", "http.fetch"
    );

    private static final int MAX_BATCH_SIZE = 8;

    /**
     * Validates a batch of info requests.
     * @throws IllegalArgumentException if any request is invalid
     */
    @SuppressWarnings("unchecked")
    public void validate(List<Map<String, Object>> requests) {
        if (requests == null || requests.isEmpty()) {
            throw new IllegalArgumentException("infoRequests is empty");
        }
        if (requests.size() > MAX_BATCH_SIZE) {
            throw new IllegalArgumentException("infoRequests exceeds max batch size: " + requests.size() + " > " + MAX_BATCH_SIZE);
        }
        for (int i = 0; i < requests.size(); i++) {
            Object reqObj = requests.get(i);
            Map<String, Object> req;
            if (reqObj instanceof Map<?, ?>) {
                req = (Map<String, Object>) reqObj;
            } else {
                throw new IllegalArgumentException(
                    "infoRequests[" + i + "] is not a Map but " + (reqObj != null ? reqObj.getClass().getName() : "null")
                    + ". Each infoRequest must be a JSON object with at least a 'kind' field.");
            }
            String kind = (String) req.get("kind");
            if (kind == null || !ALLOWED_KINDS.contains(kind)) {
                throw new IllegalArgumentException("unsupported or missing kind: " + kind);
            }
            // shell.exec must have readOnly=true
            if ("shell.exec".equals(kind)) {
                @SuppressWarnings("unchecked")
                Map<String, Object> args = (Map<String, Object>) req.getOrDefault("args", Map.of());
                Boolean readOnly = (Boolean) args.getOrDefault("readOnly", false);
                if (!Boolean.TRUE.equals(readOnly)) {
                    throw new IllegalArgumentException("shell.exec in Gather must have readOnly=true");
                }
            }
        }
    }
}