package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class GraphMarkerSanitizerTest {

  @Test
  void stripsCompleteMarkers() {
    String raw = "<<<GRAPH_JSON>>>{\"a\":1}<<<END>>><<<AGENT_CONTENT>>>hi<<<END>>>";
    assertThat(GraphMarkerSanitizer.stripForDisplay(raw)).isEqualTo("{\"a\":1}hi");
  }

  @Test
  void stripsAgentWritingMarkerAndFilePreview() {
    String raw = "<<<AGENT_WRITING>>>想要创建: doc/a.md +10行";
    assertThat(GraphContentSanitizer.stripForDisplay(raw)).isEmpty();
    String mixed = "我将编写架构文档。> 新建文件: system_architecture.md +166行";
    assertThat(GraphContentSanitizer.stripForDisplay(mixed)).isEqualTo("我将编写架构文档。");
  }

  @Test
  void stripsOrphanAngleBrackets() {
    assertThat(GraphMarkerSanitizer.stripForDisplay("开始<<<>结束")).isEqualTo("开始结束");
  }

  @Test
  void stripsTruncatedMarkers() {
    String raw =
        "AGENT_THINKING>>>我将创建doc目录。 GRAPH_JSON>>> 我将创建doc目录END>>>"
            + "AGENT_CONTENT>>>我将创建三个文档";
    String out = GraphMarkerSanitizer.stripForDisplay(raw);
    assertThat(out).doesNotContain("GRAPH_JSON");
    assertThat(out).doesNotContain("AGENT_THINKING");
    assertThat(out).doesNotContain("END>>>");
    assertThat(out).contains("我将创建doc目录");
  }

  @Test
  void filterMetaCommentaryKeepsReasoning() {
    String raw = "将采用分层架构设计插件。这是一个纯文本问答任务，不需要定制计划。接下来编写 doc 目录下的文档。";
    String out = GraphContentSanitizer.filterMetaCommentary(raw);
    assertThat(out).contains("分层架构");
    assertThat(out).doesNotContain("不需要定制计划");
  }

  @Test
  void stripsAgentWitingTypo() {
    String raw = "分析复杂度。AGENT_WITING>>>";
    assertThat(GraphMarkerSanitizer.stripForDisplay(raw)).isEqualTo("分析复杂度。");
  }

  @Test
  void stripsBareAndGluedMarkersFromPlanningLeak() {
    String raw =
        "AGENT_CONTENT>##分析用户需求用户请求是：设计插件。"
            + "END>AGENT_THINKING开始制定分步计划。 END>GRAPH_JSON"
            + "AGENT_CONTENT我需要创建doc目录。 END>AGENT_THINKING检查项目结构> GRAPH_JSON";
    String out = GraphContentSanitizer.stripForDisplay(raw);
    assertThat(out).doesNotContain("AGENT_CONTENT");
    assertThat(out).doesNotContain("AGENT_THINKING");
    assertThat(out).doesNotContain("GRAPH_JSON");
    assertThat(out).doesNotContain("END>");
    assertThat(out).contains("分析用户需求");
    assertThat(out).contains("##");
  }

  @Test
  void normalizesGluedHeadingsAndFileExtensions() {
    String raw = "前置文字。##分析用户需求\n设计文档. md和关键Prompts. md";
    String out = GraphContentSanitizer.stripForDisplay(raw);
    assertThat(out).contains("## 分析");
    assertThat(out).contains("设计文档.md");
    assertThat(out).doesNotContain(". md");
  }

  @Test
  void stripsPartialClosingPlanTag() {
    String raw = "分析完成。</plan后续步骤省略";
    assertThat(GraphContentSanitizer.stripForDisplay(raw)).doesNotContain("</plan");
    assertThat(GraphContentSanitizer.stripForDisplay(raw)).contains("分析完成");
  }

  @Test
  void stripsMalformedInlinePlanTags() {
    String raw = "分析任务。<plan-第一步：创建doc目录。-第二步：写设计文档。AGENT_CONTENT开始写文档";
    String out = GraphContentSanitizer.stripForDisplay(raw);
    assertThat(out).doesNotContain("<plan-");
    assertThat(out).doesNotContain("AGENT_CONTENT");
    assertThat(out).contains("分析任务");
  }

  @Test
  void findsOpenMarkerPositions() {
    String raw = "prefix AGENT_CONTENT>>> body";
    assertThat(GraphMarkerSanitizer.indexOfOpenMarker(raw)).isEqualTo(7);
    assertThat(GraphMarkerSanitizer.markerKindAt(raw, 7))
        .isEqualTo(GraphStreamProcessor.MARKER_CONTENT);
  }
}
