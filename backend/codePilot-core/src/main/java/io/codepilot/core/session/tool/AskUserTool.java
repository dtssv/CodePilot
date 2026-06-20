package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: ask_user — interrupt to request clarification from the user. */
@Component
public class AskUserTool {
  public static final String NAME = "ask_user";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Ask the user for clarification or input. Use this when you need the user to confirm,"
            + " choose between options, or provide missing information. The session will pause"
            + " until the user answers.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "question",
                        Map.of("type", "string", "description", "The question to ask the user."),
                    "kind",
                        Map.of(
                            "type",
                            "string",
                            "description",
                            "One of: 'single' (pick one), 'multi' (pick multiple), 'yes_no'"
                                + " (yes/no), 'freeform' (open-ended)."),
                    "options",
                        Map.of(
                            "type", "array",
                            "items",
                                Map.of(
                                    "type",
                                    "object",
                                    "properties",
                                    Map.of("label", Map.of("type", "string"))),
                            "description",
                                "Possible options to choose from (for 'single'/'multi' kinds).")),
            "required", List.of("question", "kind")),
        false,
        true // requires permission
        );
  }

  public ToolExecutor executor() {
    return call -> {
      String question = (String) call.args().get("question");
      String kind = (String) call.args().get("kind");
      return new io.codepilot.core.agent.tool.ToolResult(
          true,
          "{\n"
              + "  \"status\": \"awaiting_user_input\",\n"
              + "  \"question\": \""
              + (question != null ? question.replace("\"", "\\\"") : "")
              + "\",\n"
              + "  \"kind\": \""
              + (kind != null ? kind : "freeform")
              + "\"\n"
              + "}");
    };
  }
}
