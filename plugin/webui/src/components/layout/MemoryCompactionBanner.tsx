import { useMemoryCompaction } from '../../state/rulesMemory';

/**
 * Banner shown when the backend compresses DEGRADABLE/VOLATILE memories
 * into a single summary at phase boundaries during super-complex tasks.
 * Informs the user that context was compressed, with counts of compressed
 * and preserved memories. The __COMPACTED__ marker is used by the session
 * recovery logic to restore from compressed context instead of full history.
 */
export function MemoryCompactionBanner() {
    const compaction = useMemoryCompaction();
    if (!compaction) return null;

    return (
        <div className="memory-compaction-banner" role="status" aria-live="polite">
            <div className="memory-compaction-title">
                上下文已压缩
            </div>
            <p className="memory-compaction-message">
                为保持上下文预算，{compaction.compressedCount} 条低优先级记忆已合并为摘要
                {compaction.preservedCount > 0 && `（${compaction.preservedCount} 条关键记忆已保留）`}
                。阶段: {compaction.phaseId || '未知'}
            </p>
            <p className="memory-compaction-hint muted">
                压缩后的上下文将在后续会话恢复时自动使用，无需重放完整对话历史
            </p>
        </div>
    );
}