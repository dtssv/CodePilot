package io.codepilot.core.tool;

import io.codepilot.core.memory.MemoryType;
import io.codepilot.core.memory.ProtectionLevel;

import java.util.List;

/**
 * Memory classification profile attached to a tool definition.
 *
 * <p>Each tool declares what kind of memory its successful results produce:
 * <ul>
 *   <li>{@link #defaultProtection()} — the protection level for results</li>
 *   <li>{@link #defaultType()} — the memory type for results</li>
 *   <li>{@link #defaultTags()} — tags automatically attached to results</li>
 *   <li>{@link #memoryWorthy()} — whether results should be proposed as memory candidates</li>
 * </ul>
 *
 * <p>This replaces content-based keyword guessing: the tool knows what it produces,
 * so it can declare its classification upfront.  Unknown/MCP tools default to
 * {@code memoryWorthy=false}, meaning their results won't be proposed as memory
 * candidates unless they explicitly embed {@code memoryHint} or {@code resultType}
 * metadata in their result map.
 */
public record ToolMemoryProfile(
        /** Whether successful results from this tool should be proposed as memory candidates. */
        boolean memoryWorthy,
        /** Default protection level for memory candidates from this tool. */
        ProtectionLevel defaultProtection,
        /** Default memory type for memory candidates from this tool. */
        MemoryType defaultType,
        /** Default tags for memory candidates from this tool (e.g. ["source", "code"]). */
        List<String> defaultTags
) {
    /** A non-memory-worthy profile (the safe default for unknown tools). */
    public static final ToolMemoryProfile NOT_WORTHY = new ToolMemoryProfile(
            false, ProtectionLevel.VOLATILE, MemoryType.FACT, List.of());

    /** Profile for tools that produce architecture-level information (e.g. source.read). */
    public static final ToolMemoryProfile ARCHITECTURE = new ToolMemoryProfile(
            true, ProtectionLevel.IMMORTAL, MemoryType.ARCHITECTURE, List.of());

    /** Profile for tools that produce dependency/stack information. */
    public static final ToolMemoryProfile DEPENDENCY = new ToolMemoryProfile(
            true, ProtectionLevel.PROTECTED, MemoryType.ARCHITECTURE, List.of("dependency"));

    /** Profile for tools that produce API contract information. */
    public static final ToolMemoryProfile API_CONTRACT = new ToolMemoryProfile(
            true, ProtectionLevel.IMMORTAL, MemoryType.API_CONTRACT, List.of("api"));

    /** Profile for tools that produce decision records. */
    public static final ToolMemoryProfile DECISION = new ToolMemoryProfile(
            true, ProtectionLevel.PROTECTED, MemoryType.DECISION, List.of());

    /** Profile for tools that produce schema/data-model information. */
    public static final ToolMemoryProfile SCHEMA = new ToolMemoryProfile(
            true, ProtectionLevel.IMMORTAL, MemoryType.ARCHITECTURE, List.of("schema"));

    /** Create a custom profile. */
    public static ToolMemoryProfile of(boolean memoryWorthy, ProtectionLevel protection,
                                        MemoryType type, List<String> tags) {
        return new ToolMemoryProfile(memoryWorthy, protection, type, tags);
    }
}