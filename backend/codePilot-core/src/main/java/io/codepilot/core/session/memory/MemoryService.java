package io.codepilot.core.session.memory;

import io.codepilot.core.session.SessionState;
import java.util.List;

/**
 * Memory service interface — manages persistent memory across sessions.
 *
 * <p>Memory/index.ts + service.ts, which uses SQLite FTS5 for full-text
 * search across MEMORY.md, checkpoint.md, notes.md, and distilled content.
 *
 * <p>Four-layer memory system:
 *
 * <ul>
 *   <li>CHECKPOINT — Structured session state snapshots
 *   <li>PERSISTENT — Long-lived project knowledge (MEMORY.md equivalent)
 *   <li>SESSION — Per-session context and notes
 *   <li>DISTILLED — Extracted knowledge from past sessions
 * </ul>
 */
public interface MemoryService {

  /** Load memories relevant to the current task. */
  List<MemoryEntry> loadRelevant(String query, String sessionId);

  /** Save a new memory entry. */
  void save(MemoryEntry entry);

  /** Distill conversation into persistent memory (extract durable knowledge). */
  void distill(SessionState session);

  /** Format a list of memories into a prompt-friendly string. */
  String formatForPrompt(List<MemoryEntry> memories);

  /** Search memories by query with optional FTS. Returns up to `limit` results. */
  List<MemoryEntry> search(String query, String sessionId, int limit);

  /** Write a new memory entry with the specified type. */
  void writeMemory(String sessionId, String type, String content);

  /** Delete a memory entry by ID. */
  void deleteMemory(String id);
}
