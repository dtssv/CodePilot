package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * User-facing plan: a stable, high-level summary of what will be done.
 * Displayed in the Plan panel, rarely changes once produced.
 *
 * <p>Distinct from the internal {@code phases[]} (execution plan) which drives
 * the Graph engine and evolves dynamically during execution.
 *
 * <p>Lifecycle:
 * <ul>
 *   <li>Created once by PlanningAction → emitted as SSE {@code user_plan}</li>
 *   <li>Progress updated by CommitAction on each phase completion → SSE {@code user_plan_progress}</li>
 *   <li>Status set to failed/blocked by RepairAction when budget exhausted → SSE {@code user_plan_progress}</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record UserPlan(
    String goal,
    String summary,
    List<UserStep> steps,
    Status status
) {
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UserStep(
        String id,
        int index,
        String title,
        String description,
        StepStatus status
    ) {}

    public enum Status {
        @JsonProperty("in_progress") IN_PROGRESS,
        @JsonProperty("completed")   COMPLETED,
        @JsonProperty("failed")      FAILED
    }

    public enum StepStatus {
        @JsonProperty("pending")     PENDING,
        @JsonProperty("in_progress") IN_PROGRESS,
        @JsonProperty("completed")   COMPLETED,
        @JsonProperty("failed")      FAILED,
        @JsonProperty("skipped")     SKIPPED
    }
}