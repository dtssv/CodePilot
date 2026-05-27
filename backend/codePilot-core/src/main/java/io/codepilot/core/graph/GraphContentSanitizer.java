package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Sanitizes LLM user-visible text before SSE. */
public final class GraphContentSanitizer {

  /** Meta commentary about plan modes — hide from user, keep real reasoning. */
  private static final Pattern META_SENTENCE =
      Pattern.compile(
          ".*(?:skipPlan|OUTPUT\\s*MODE|不需要定制计划|无需修改代码|纯文本问答|"
              + "whether to create a plan|task classification|是否.*(?:定制|需要).*计划|"
              + "这是一个.*问答任务|不涉及对现有代码).*",
          Pattern.CASE_INSENSITIVE);

  /** Repeated restatements of the user goal across phases (planning already covered this). */
  private static final Pattern REPETITIVE_USER_GOAL =
      Pattern.compile(
          ".*(?:用户要求|根据项目上下文|根据GATHERED CONTEXT|我的方法是先|行动计划|"
              + "开始制定.*计划|我将检查.*CMake|根目录下已存在).*",
          Pattern.CASE_INSENSITIVE);

  /** Tool-card style file summaries that must not appear in model prose (shown via agent_writing / tool UI). */
  private static final Pattern FILE_TOOL_PREVIEW =
      Pattern.compile(
          "(?:^|\\s|>|[。！？!?])\\s*(?:想要)?(?:新建文件|新建|创建|修改|删除|写入)(?:文件)?[:：]\\s*\\S+(?:\\s*\\+\\d+\\s*行)?",
          Pattern.CASE_INSENSITIVE | Pattern.MULTILINE);

  private GraphContentSanitizer() {}

  /** Strip markers, file previews, and normalize {@code <plan>} for user-visible SSE text. */
  public static String stripForDisplay(String text) {
    if (text == null || text.isBlank()) {
      return text;
    }
    if (GraphJsonLeakGuard.looksLikeGraphGenerateJson(text)) {
      return "";
    }
    String s = text.replaceAll("(?is)<file(?:path)?\\s[^>]*>[\\s\\S]*?</file(?:path)?>", "");
    s = s.replaceAll("(?is)<plan>([\\s\\S]*?)</plan>", "$1");
    s = s.replaceAll("(?i)</?plan>", "");
    s = s.replaceAll("(?i)</plan[^>\\n]*", "");
    s = s.replaceAll("(?i)</plan\\s*$", "");
    s = s.replaceAll("(?i)</plan(?!>)", "");
    // Malformed inline plan tags, e.g. <plan-第一步：…> from planning leaks
    s = s.replaceAll("(?i)<plan-[^>\\n]*", "");
    s = s.replaceAll("(?i)<plan\\s+[^>\\n]*", "");
    s = s.replaceAll("(?i)<plan[^>\\n]*", "");
    s = stripFileToolPreviews(s);
    s = GraphMarkerSanitizer.stripForDisplay(s);
    s = stripFileToolPreviews(s);
    s = stripSimulatedShellOutput(s);
    s = filterMetaCommentary(s);
    s = normalizeMarkdown(s);
    s = s.replaceAll("(?m)\\s*>\\s*$", "").trim();
    return s;
  }

  /** CJK punctuation before {@code #} heading (not {@code 1. #} list glue). */
  private static final Pattern GLUED_HEADING_CJK =
      Pattern.compile("([。！？!?])(\\s*)(#{1,6})(\\S)");

  /** ASCII period before {@code #} only when not part of {@code 1.} ordered list. */
  private static final Pattern GLUED_HEADING_PERIOD =
      Pattern.compile("(?<!\\d)\\.(\\s*)(#{1,6})(\\S)");

  /** {@code # # 1. item} → {@code 1. item}. */
  private static final Pattern HASHES_BEFORE_ORDERED_LIST =
      Pattern.compile("(?m)^(?:#\\s+)+(?=\\d+\\.\\s)");

  /** {@code ## 1. Title} → {@code 1. Title} (not an ATX heading). */
  private static final Pattern HEADING_THAT_IS_ORDERED_LIST =
      Pattern.compile("(?m)^#{1,6}\\s+(\\d+\\.\\s+.+)$");

  /** {@code ##分析} → {@code ## 分析} (GFM requires space after # marks). */
  private static final Pattern HEADING_NO_SPACE =
      Pattern.compile("^(#{1,6})([^\\s#].*)$", Pattern.MULTILINE);

  /** {@code 设计文档. md} / {@code 设计文档 .md} → {@code 设计文档.md}. */
  private static final Pattern SPACED_EXTENSION =
      Pattern.compile(
          "([\\w\\u4e00-\\u9fff\\-]+)\\s*\\.\\s+(md|txt|cpp|hpp|h|cc|c|java|kt|json|yaml|yml|xml|gradle|cmake)\\b",
          Pattern.CASE_INSENSITIVE);

  /** {@code 。 -第五步：} → newline before {@code 第五步：}. */
  private static final Pattern GLUED_CHINESE_STEP =
      Pattern.compile(
          "([。！？；;）)])\\s*[-–—]?\\s*(第[一二三四五六七八九十百千万0-9]+步\\s*[：:])");

  /** {@code -第五步：} at line start after text. */
  private static final Pattern DASH_CHINESE_STEP =
      Pattern.compile("(?<=[\\u4e00-\\u9fff）)])\\s*[-–—]\\s*(第[一二三四五六七八九十百千万0-9]+步\\s*[：:])");

  private static final Pattern ORDERED_LIST_LINE =
      Pattern.compile("^(\\s*)(\\d+)\\.\\s*(.*)$");

  /** Ensure blank lines before headings/lists so markdown parsers structure content correctly. */
  public static String normalizeMarkdown(String text) {
    if (text == null || text.isBlank()) {
      return text == null ? "" : text;
    }
    String s = text.replace("\r\n", "\n");
    s = s.replaceAll("(?i)<br\\s*/?>", "\n");
    s = HASHES_BEFORE_ORDERED_LIST.matcher(s).replaceAll("");
    s = HEADING_THAT_IS_ORDERED_LIST.matcher(s).replaceAll("$1");
    s = SPACED_EXTENSION.matcher(s).replaceAll("$1.$2");
    s = GLUED_HEADING_CJK.matcher(s).replaceAll("$1\n\n$2$3 $4");
    s = GLUED_HEADING_PERIOD.matcher(s).replaceAll(".\n\n$1$2 $3");
    s = HEADING_NO_SPACE.matcher(s).replaceAll("$1 $2");
    s = s.replaceAll("([^\\n])\\n(#{1,6}\\s)", "$1\n\n$2");
    s = s.replaceAll("([^\\n])\\n(\\s*[-*+]\\s)", "$1\n\n$2");
    s = s.replaceAll("([^\\n])\\n(\\s*\\d+\\.\\s)", "$1\n\n$2");
    s = s.replaceAll("(?m)^(\\d+)\\.(\\S)", "$1. $2");
    s = s.replaceAll("([^\\n])\\s+([-*+])\\s+(?=\\S)", "$1\n\n$2 ");
    s = s.replaceAll("([。！？])\\s*>\\s*(?=[\\u4e00-\\u9fffA-Za-z])", "$1\n\n");
    s = GLUED_CHINESE_STEP.matcher(s).replaceAll("$1\n\n$2");
    s = DASH_CHINESE_STEP.matcher(s).replaceAll("\n\n$1");
    s = fixRepeatedOrderedListOnes(s);
    // Do not insert blank lines between consecutive ordered-list items
    s = s.replaceAll("(?m)(\\d+\\.\\s+.*)\\n\\n+(\\d+\\.\\s)", "$1\n$2");
    s = s.replaceAll("\\*{3,}", "**");
    s = s.replaceAll("```(\\w*)([^\\n`])", "```$1\n$2");
    s = s.replaceAll("\\n{3,}", "\n\n");
    return s.trim();
  }

  /**
   * LLMs often emit {@code 1.} for every ordered-list line; GFM then shows all as "1." Renumber
   * consecutive blocks where every line starts with {@code 1.}.
   */
  static String fixRepeatedOrderedListOnes(String s) {
    if (s == null || s.isBlank()) {
      return s == null ? "" : s;
    }
    String[] lines = s.split("\n", -1);
    StringBuilder out = new StringBuilder();
    int i = 0;
    while (i < lines.length) {
      if (!ORDERED_LIST_LINE.matcher(lines[i]).matches()) {
        out.append(lines[i]);
        if (i < lines.length - 1) {
          out.append('\n');
        }
        i++;
        continue;
      }
      int blockStart = i;
      int blockEnd = i;
      while (blockEnd < lines.length) {
        String line = lines[blockEnd];
        if (line.trim().isEmpty()) {
          if (blockEnd + 1 < lines.length
              && ORDERED_LIST_LINE.matcher(lines[blockEnd + 1]).matches()) {
            blockEnd++;
            continue;
          }
          break;
        }
        if (!ORDERED_LIST_LINE.matcher(line).matches()) {
          break;
        }
        blockEnd++;
      }
      List<String[]> items = new ArrayList<>();
      boolean allOnes = true;
      for (int j = blockStart; j < blockEnd; j++) {
        String line = lines[j];
        if (line.trim().isEmpty()) {
          continue;
        }
        var m = ORDERED_LIST_LINE.matcher(line);
        if (!m.matches()) {
          allOnes = false;
          break;
        }
        if (!"1".equals(m.group(2))) {
          allOnes = false;
        }
        items.add(new String[] {m.group(1), m.group(3)});
      }
      if (allOnes && items.size() >= 2) {
        int num = 1;
        for (String[] item : items) {
          out.append(item[0]).append(num++).append(". ").append(item[1]).append('\n');
        }
      } else {
        for (int j = blockStart; j < blockEnd; j++) {
          out.append(lines[j]).append('\n');
        }
      }
      i = blockEnd;
    }
    String result = out.toString();
    if (!result.isEmpty() && result.charAt(result.length() - 1) == '\n') {
      result = result.substring(0, result.length() - 1);
    }
    return result;
  }

  /**
   * Removes LLM-fabricated terminal/program output (real output appears in shell tool cards).
   */
  public static String stripSimulatedShellOutput(String text) {
    if (text == null || text.isBlank()) {
      return text == null ? "" : text;
    }
    String[] lines = text.split("\n");
    List<String> kept = new ArrayList<>();
    for (String line : lines) {
      String t = line.trim();
      if (t.matches("(?i).*(Red-Black Tree|inorder traversal|Deleting \\d+\\.\\.\\.|constructed tree:).*")) {
        continue;
      }
      if (t.matches("(?i)^(mkdir -p build|cd build|cd cmake-build-debug|cmake \\.\\.|make\\b|\\.\\/[\\w./-]+)$")) {
        continue;
      }
      if (t.matches("(?i).*(正在|配置|编译|查找|运行).*(\\.\\.\\.|…)?\\s*success\\s*$")) {
        continue;
      }
      if (t.matches("(?i)^\\s*success\\s*$")) {
        continue;
      }
      kept.add(line);
    }
    return String.join("\n", kept).trim();
  }

  /** Remove inline tool-style file change summaries (e.g. {@code 新建文件: foo.md +10行}). */
  public static String stripFileToolPreviews(String text) {
    if (text == null || text.isBlank()) {
      return text == null ? "" : text;
    }
    String s = FILE_TOOL_PREVIEW.matcher(text).replaceAll("");
    s = s.replaceAll("(?<=。)\\s*>\\s*(?=[\\u4e00-\\u9fffA-Za-z])", "");
    return s.replaceAll("\\s{2,}", " ").trim();
  }

  /**
   * Removes sentences about plan/skipPlan/mode selection while keeping design reasoning intact.
   */
  public static String filterMetaCommentary(String text) {
    if (text == null || text.isBlank()) {
      return text == null ? "" : text;
    }
    String[] parts = text.split("(?<=[。！？.!?])\\s*");
    List<String> kept = new ArrayList<>();
    for (String part : parts) {
      String trimmed = part.trim();
      if (trimmed.isEmpty()) {
        continue;
      }
      if (META_SENTENCE.matcher(trimmed).matches()
          || REPETITIVE_USER_GOAL.matcher(trimmed).matches()) {
        continue;
      }
      kept.add(trimmed);
    }
    if (kept.isEmpty()) {
      return text.trim();
    }
    return String.join("\n", kept).trim();
  }

  /** @deprecated use {@link #stripForDisplay} */
  @Deprecated
  public static String stripFilePreviewTags(String text) {
    return stripForDisplay(text);
  }
}
