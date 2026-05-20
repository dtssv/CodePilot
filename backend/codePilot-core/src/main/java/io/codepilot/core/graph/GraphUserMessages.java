package io.codepilot.core.graph;

import java.util.List;
import java.util.Map;

/**
 * Fallback copy when the graph must ask the user without an LLM-generated askUser block.
 * Wording for LLM-driven askUser is controlled via prompts (same language as user input).
 */
public final class GraphUserMessages {

  private GraphUserMessages() {}

  public static Map<String, Object> stepStuckQuestion(String phaseId) {
    return Map.of(
        "id",
        "step-stuck-" + phaseId,
        "text",
        "当前计划步骤已多次尝试仍未完成。请选择下一步：",
        "kind",
        "single-choice",
        "options",
        List.of(
            Map.of("id", "alternative", "label", "换一种方式"),
            Map.of("id", "skip", "label", "跳过此步骤"),
            Map.of("id", "abort", "label", "停止任务")));
  }

  public static Map<String, Object> repairBudgetQuestion(
      String phaseId, int attempts, boolean partial, long appliedCount) {
    if (partial && appliedCount > 0) {
      return Map.of(
          "id",
          "repair-partial-" + phaseId,
          "text",
          "自动修复已部分成功（已应用 " + appliedCount + " 处修改）。请选择：",
          "kind",
          "single-choice",
          "options",
          List.of(
              Map.of("id", "continue", "label", "继续（保留部分修改）"),
              Map.of("id", "revert", "label", "撤销修改并重新规划")));
    }
    return Map.of(
        "id",
        "repair-failed-" + phaseId,
        "text",
        "自动修复在 " + attempts + " 次尝试后仍未通过验证。请选择：",
        "kind",
        "single-choice",
        "options",
        List.of(
            Map.of("id", "manual", "label", "我手动处理"),
            Map.of("id", "revert", "label", "撤销修改并重新规划"),
            Map.of("id", "adjust", "label", "调整修复策略")));
  }

  public static Map<String, Object> repairParseFailedQuestion(String phaseId, int attempt) {
    return Map.of(
        "id",
        "repair-parse-failed-" + phaseId,
        "text",
        "未能生成有效的修复方案（第 " + attempt + " 次尝试）。请选择：",
        "kind",
        "single-choice",
        "options",
        List.of(
            Map.of("id", "manual", "label", "我手动处理"),
            Map.of("id", "revert", "label", "撤销修改并重新规划"),
            Map.of("id", "retry", "label", "重试修复")));
  }

  public static Map<String, Object> defaultYesNoProceed(String askText) {
    return Map.of(
        "text",
        askText,
        "kind",
        "single-choice",
        "options",
        List.of(
            Map.of("id", "yes", "label", "是，继续"),
            Map.of("id", "no", "label", "否，重新考虑")));
  }
}
