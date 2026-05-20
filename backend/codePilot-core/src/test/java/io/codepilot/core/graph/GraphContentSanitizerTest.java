package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class GraphContentSanitizerTest {

  @Test
  void renumbersRepeatedOneMarkers() {
    String in =
        "潜在风险与考虑：\n\n"
            + "1.某些文件可能包含多个算法。\n"
            + "1.复杂度分析依赖于理解。\n"
            + "1.如果项目中有非标准命名。\n"
            + "1.输出目录lc可能已存在。";
    String out = GraphContentSanitizer.fixRepeatedOrderedListOnes(in);
    assertThat(out).contains("1.某些文件");
    assertThat(out).contains("2.复杂度分析");
    assertThat(out).contains("3.如果项目中");
    assertThat(out).contains("4.输出目录lc");
  }

  @Test
  void splitsGluedChineseStepLabel() {
    String in = "目录（如果不存在）。-第五步：将Markdown报告写入 lc目录。";
    String out = GraphContentSanitizer.normalizeMarkdown(in);
    assertThat(out).contains("目录（如果不存在）。");
    assertThat(out).contains("第五步：");
    assertThat(out).doesNotContain(")。-第五步");
  }

  @Test
  void stripsDoubleHashBeforeOrderedList() {
    String in = "# # 1. 列出项目根目录\n# # 2. 读取算法文件";
    String out = GraphContentSanitizer.normalizeMarkdown(in);
    assertThat(out).isEqualTo("1. 列出项目根目录\n2. 读取算法文件");
  }

  @Test
  void convertsHeadingStyledNumberedLineToList() {
    String in = "## 1. 分析复杂度\n## 2. 写入 lc 目录";
    String out = GraphContentSanitizer.normalizeMarkdown(in);
    assertThat(out).contains("1. 分析复杂度");
    assertThat(out).contains("2. 写入 lc 目录");
    assertThat(out).doesNotContain("##");
  }

  @Test
  void doesNotBreakOrderedListBeforeHash() {
    String in = "1. # 不是标题\n2. 第二项";
    String out = GraphContentSanitizer.normalizeMarkdown(in);
    assertThat(out).contains("1. # 不是标题");
    assertThat(out).doesNotContain("1\n\n#");
  }

  @Test
  void normalizeMarkdownFixesListAndStepsTogether() {
    String in =
        "目录（如果不存在）。-第五步：写入 lc。\n\n"
            + "潜在风险：\n\n1.第一项。\n1.第二项。";
    String out = GraphContentSanitizer.normalizeMarkdown(in);
    assertThat(out).contains("\n\n第五步：");
    assertThat(out).contains("1.第一项");
    assertThat(out).contains("2.第二项");
  }
}
