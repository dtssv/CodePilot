/**
 * Sticky needs_input UI above the chat input bar (main session).
 */

import { NeedsInputCard } from './NeedsInputCard';
import {
    clearPendingNeedsInput,
    useNeedsInputSubmitted,
    usePendingNeedsInput,
} from '../state/needsInputStore';

type NeedsInputCardPayload = Parameters<typeof NeedsInputCard>[0]['payload'];

export function NeedsInputDock() {
    const payload = usePendingNeedsInput();
    const submitted = useNeedsInputSubmitted(payload?.continuationToken);
    if (!payload || submitted) return null;

    return (
        <div className="needs-input-dock">
            <NeedsInputCard
                payload={payload as unknown as NeedsInputCardPayload}
                onAnswered={() => clearPendingNeedsInput()}
            />
        </div>
    );
}
