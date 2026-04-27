package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/** Single tool call requested by the model. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ToolCall(
    String id, String name, Map<String, Object> args, Risk riskLevel, String why) {

  public enum Risk {
    @JsonProperty("low")
    LOW,
    @JsonProperty("medium")
    MEDIUM,
    @JsonProperty("high")
    HIGH
  }
}