/**
 * Session / branch UI state — extracted from App.tsx for layout slimming.
 */

import { useEffect, useState } from 'react';
import type { SessionInfoV2 } from '../components/sessions/SessionSidebarV2';

export interface BranchInfo {
    branchId: string;
    sessionId: string;
    parentBranchId: string | null;
    forkMsgIndex: number | null;
    title?: string;
    createdAt?: string | number;
    messageCount?: number;
    active?: boolean;
}

type SessionsListener = (s: SessionInfoV2[], activeId: string) => void;
type BranchesListener = (b: BranchInfo[], activeBranchId: string) => void;

let sessions: SessionInfoV2[] = [];
let activeSessionId = '';
/** True after "New chat" until the first turn of the new session completes. */
let pendingNewChat = false;
/** Bumped on each new chat; used to block stale hydration and empty backend context. */
let chatClearEpoch = 0;
let branches: BranchInfo[] = [];
let activeBranchId = 'main';

const sessionListeners = new Set<SessionsListener>();
const branchListeners = new Set<BranchesListener>();

function notifySessions() {
    sessionListeners.forEach((l) => l(sessions, activeSessionId));
}

function notifyBranches() {
    branchListeners.forEach((l) => l(branches, activeBranchId));
}

export function setSessionList(list: SessionInfoV2[], activeId: string) {
    sessions = list;
    if (pendingNewChat) {
        // Do not adopt sidebar "active" session while user is in a fresh chat — that restores old history.
        notifySessions();
        return;
    }
    activeSessionId = activeId;
    notifySessions();
}

export function setActiveSessionId(id: string, opts?: { promote?: boolean }) {
    activeSessionId = id;
    if (id && !opts?.promote) {
        pendingNewChat = false;
    }
    notifySessions();
}

export function markPendingNewChat() {
    pendingNewChat = true;
    chatClearEpoch += 1;
    activeSessionId = '';
    notifySessions();
}

export function isPendingNewChat(): boolean {
    return pendingNewChat;
}

export function getChatClearEpoch(): number {
    return chatClearEpoch;
}

/** Called when plugin confirms the fresh session turn finished (or user switched away). */
export function completeFreshChat() {
    pendingNewChat = false;
}

export function setBranchList(list: BranchInfo[], activeId: string) {
    branches = list;
    activeBranchId = activeId;
    notifyBranches();
}

export function subscribeSessions(l: SessionsListener): () => void {
    sessionListeners.add(l);
    l(sessions, activeSessionId);
    return () => sessionListeners.delete(l);
}

export function subscribeBranches(l: BranchesListener): () => void {
    branchListeners.add(l);
    l(branches, activeBranchId);
    return () => branchListeners.delete(l);
}

export function useSessions(): { sessions: SessionInfoV2[]; activeSessionId: string } {
    const [state, setState] = useState({ sessions, activeSessionId });
    useEffect(() => subscribeSessions((s, id) => setState({ sessions: s, activeSessionId: id })), []);
    return state;
}

export function useBranches(): { branches: BranchInfo[]; activeBranchId: string } {
    const [state, setState] = useState({ branches, activeBranchId });
    useEffect(() => subscribeBranches((b, id) => setState({ branches: b, activeBranchId: id })), []);
    return state;
}

export function getActiveSessionId(): string {
    return activeSessionId;
}
