/**
 * Chat send / session actions extracted from App.tsx.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { sendToPlugin } from '../bridge';
import type { ContextChipData } from '../components/ContextChip';
import type { ImageData } from '../components/ImageAttachment';
import type { ModelOption } from './modelAuthBridge';
import type { ChatMessage } from './chatTypes';
import { logConsole } from './consoleStore';
import { resetChatV2 } from './chatStore';
import { getActiveSessionId, getChatClearEpoch, isPendingNewChat, markPendingNewChat } from './sessionUiStore';
import { validateVisionSend } from './visionValidate';

export interface SendBridgeDeps {
    v2Enabled: boolean;
    mode: 'agent' | 'chat';
    messages: ChatMessage[];
    selectedModelId: string;
    models: ModelOption[];
    maxMode: boolean;
    activeReplyRef: MutableRefObject<boolean>;
    activeTurnIdRef: MutableRefObject<string>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setContextChips: Dispatch<SetStateAction<ContextChipData[]>>;
    onSendBlocked?: (message: string | null) => void;
}

export function createSendHandlers(deps: SendBridgeDeps) {
    const {
        v2Enabled,
        mode,
        messages,
        selectedModelId,
        models,
        maxMode,
        activeReplyRef,
        activeTurnIdRef,
        setMessages,
        setContextChips,
        onSendBlocked,
    } = deps;

    const handleSend = (text: string, chips: ContextChipData[], images?: ImageData[]) => {
        const visionError = validateVisionSend(images, selectedModelId, models, maxMode);
        if (visionError) {
            onSendBlocked?.(visionError);
            return;
        }
        onSendBlocked?.(null);

        activeReplyRef.current = true;
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeTurnIdRef.current = turnId;

        const contextRefsForUi = chips.map((chip) => ({
            display: chip.display,
            type: chip.type,
        }));
        if (!v2Enabled) {
            setMessages((prev) => [
                ...prev,
                { role: 'user' as const, content: text, contextRefs: contextRefsForUi, turnId },
                { role: 'assistant' as const, content: '', _streaming: true, turnId },
            ]);
        }

        const contextRefs = chips.map((chip) => ({
            id: chip.id,
            display: chip.display,
            type: chip.type,
            filePath: chip.filePath,
            language: chip.language,
            startLine: chip.startLine,
            endLine: chip.endLine,
        }));

        const freshChat = isPendingNewChat();
        const includeHistory = !freshChat && getActiveSessionId() !== '';
        const historyMessages = includeHistory
            ? messages
                  .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
                  .map((msg) => ({
                      role: msg.role,
                      content: msg.content.length > 4000 ? msg.content.substring(0, 4000) + '...' : msg.content,
                  }))
            : [];

        const msgPayload = {
            text,
            contextRefs,
            mode,
            modelId: selectedModelId || undefined,
            modelSource:
                selectedModelId && selectedModelId !== 'auto'
                    ? models.find((m) => m.id === selectedModelId)?.type === 'custom'
                        ? 'custom'
                        : 'group'
                    : undefined,
            maxMode,
            images: images?.map((img) => ({ name: img.name, mimeType: img.mimeType, base64: img.base64 })),
            historyMessages,
            freshChat,
            ...(freshChat ? { chatClearEpoch: getChatClearEpoch() } : {}),
        };
        logConsole('bridge', 'sendToPlugin:user_message', {
            text: text.substring(0, 100),
            mode,
            contextRefsCount: contextRefs.length,
            historyCount: historyMessages.length,
        });
        sendToPlugin('user_message', msgPayload);
        setContextChips([]);
    };

    const handleStop = () => {
        sendToPlugin('stop', {});
    };

    const clearSessionLocalState = (
        setAbnormalTermination: (v: boolean) => void,
        setHasCheckpoint: (v: boolean) => void,
        setRecoveryMode: (v: 'exact' | 'soft' | 'none') => void,
        setIsResuming: (v: boolean) => void,
    ) => {
        resetChatV2(undefined, { suppressEnvelopes: true });
        setMessages([]);
        setContextChips([]);
        setAbnormalTermination(false);
        setHasCheckpoint(false);
        setRecoveryMode('none');
        setIsResuming(false);
        activeReplyRef.current = false;
        activeTurnIdRef.current = '';
    };

    return { handleSend, handleStop, clearSessionLocalState };
}

export function createSessionActions(clearSessionLocalState: ReturnType<typeof createSendHandlers>['clearSessionLocalState']) {
    return {
        handleNewSession: (
            setHistoryOpen: (v: boolean) => void,
            setAbnormalTermination: (v: boolean) => void,
            setHasCheckpoint: (v: boolean) => void,
            setRecoveryMode: (v: 'exact' | 'soft' | 'none') => void,
            setIsResuming: (v: boolean) => void,
        ) => {
            markPendingNewChat();
            clearSessionLocalState(setAbnormalTermination, setHasCheckpoint, setRecoveryMode, setIsResuming);
            setHistoryOpen(false);
            sendToPlugin('new_session', {});
        },
        handleSelectSession: (id: string, activeSessionId: string | null, setHistoryOpen: (v: boolean) => void) => {
            if (id !== activeSessionId) {
                sendToPlugin('switch_session', { sessionId: id });
            }
            setHistoryOpen(false);
        },
        handleDeleteSession: (id: string) => {
            sendToPlugin('delete_session', { sessionId: id });
        },
    };
}

export function handleRemoveContextChip(
    id: string,
    setContextChips: Dispatch<SetStateAction<ContextChipData[]>>,
) {
    setContextChips((prev) => prev.filter((c) => c.id !== id));
}
