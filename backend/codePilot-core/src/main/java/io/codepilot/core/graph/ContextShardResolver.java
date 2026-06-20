package io.codepilot.core.graph;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Unified context-shard loading for generate, phase memory loader, and plan expand.
 * Respects LLM {@link PhaseMemoryHelper.LoadShardMode} — no silent {@code loadAll} on empty tags.
 */
public final class ContextShardResolver {

  private static final Logger log = LoggerFactory.getLogger(ContextShardResolver.class);

  private ContextShardResolver() {}

  public record ResolvedShards(
      List<ContextShardStore.ContextShard> shards, String promptSection, int charsUsed) {}

  public static ResolvedShards resolveForPrompt(
      ContextShardStore shardStore,
      String projectRootHash,
      String contextSourceId,
      List<String> queryTags,
      PhaseMemoryHelper.LoadShardMode mode,
      int maxChars) {
    if (projectRootHash == null
        || projectRootHash.isBlank()
        || contextSourceId == null
        || contextSourceId.isBlank()) {
      return new ResolvedShards(List.of(), "", 0);
    }
    if (mode == PhaseMemoryHelper.LoadShardMode.NONE) {
      return new ResolvedShards(List.of(), "", 0);
    }

    List<ContextShardStore.ContextShard> shards;
    try {
      if (mode == PhaseMemoryHelper.LoadShardMode.ALL) {
        shards = shardStore.loadAll(projectRootHash, contextSourceId).block();
      } else if (queryTags == null || queryTags.isEmpty()) {
        log.info("ContextShardResolver: loadShardMode=tags but no query tags — skipping shard load");
        return new ResolvedShards(List.of(), "", 0);
      } else {
        shards = shardStore.loadByTags(projectRootHash, contextSourceId, queryTags).block();
      }
      if (shards == null) {
        shards = List.of();
      }
    } catch (Exception e) {
      log.warn("ContextShardResolver: shard load failed (non-fatal): {}", e.getMessage());
      return new ResolvedShards(List.of(), "", 0);
    }

    if (shards.isEmpty()) {
      return new ResolvedShards(List.of(), "", 0);
    }

    String section = formatShardsForPrompt(shards, maxChars > 0 ? maxChars : 8000);
    int chars = section.length();
    return new ResolvedShards(shards, section, chars);
  }

  public static List<ContextShardStore.ContextShard> resolveShards(
      ContextShardStore shardStore,
      String projectRootHash,
      String contextSourceId,
      List<String> queryTags,
      PhaseMemoryHelper.LoadShardMode mode) {
    return resolveForPrompt(shardStore, projectRootHash, contextSourceId, queryTags, mode, 0).shards();
  }

  private static String formatShardsForPrompt(
      List<ContextShardStore.ContextShard> shards, int maxChars) {
    StringBuilder sb = new StringBuilder("\n\n[RELEVANT CONTEXT — sections for this phase]\n");
    int totalChars = 0;
    for (var shard : shards) {
      String shardContent = shard.content();
      boolean usedSummary = false;
      if (totalChars + shardContent.length() > maxChars
          && shard.summary() != null
          && !shard.summary().isBlank()) {
        shardContent = shard.summary();
        usedSummary = true;
      }
      if (totalChars + shardContent.length() > maxChars) {
        sb.append("(... more sections omitted — use gather/fs.read if needed)\n");
        break;
      }
      sb.append("── ")
          .append(shard.id())
          .append(" [")
          .append(String.join(", ", shard.tags()))
          .append("] ──\n");
      if (usedSummary) {
        sb.append("[SUMMARY] ").append(shardContent).append("\n\n");
      } else {
        sb.append(shardContent).append("\n\n");
      }
      totalChars += shardContent.length();
    }
    return sb.toString();
  }
}
