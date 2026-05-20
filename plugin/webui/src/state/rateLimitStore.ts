/**
 * Gateway rate limit (HTTP 429) — blocks send until retry window elapses.
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';
import { clearPendingNeedsInput } from './needsInputStore';
import { finalizeRunningTurns } from './chatStore';

export const RATE_LIMITED_API_CODE = 42901;

export interface RateLimitState {
    message: string;
    retryAfterSec: number;
    blockedUntil: number;
    opType?: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let active: RateLimitState | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function notify() {
    listeners.forEach((l) => l());
}

function clearTickTimer() {
    if (tickTimer != null) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
}

function scheduleTick() {
    clearTickTimer();
    if (!active) return;
    tickTimer = setInterval(() => {
        if (!active || Date.now() >= active.blockedUntil) {
            active = null;
            clearTickTimer();
            notify();
        } else {
            notify();
        }
    }, 1000);
}

export function getRateLimitState(): RateLimitState | null {
    if (!active) return null;
    if (Date.now() >= active.blockedUntil) {
        active = null;
        clearTickTimer();
        return null;
    }
    return active;
}

export function isRateLimited(): boolean {
    return getRateLimitState() != null;
}

export function clearRateLimit(): void {
    if (!active) return;
    active = null;
    clearTickTimer();
    notify();
}

export function applyRateLimited(payload: {
    message?: string;
    retryAfterSec?: number;
    opType?: string;
}): void {
    const retryAfterSec = Math.max(1, payload.retryAfterSec ?? 60);
    const blockedUntil = Date.now() + retryAfterSec * 1000;
    active = {
        message: payload.message?.trim() || '请求过于频繁，请稍后再试',
        retryAfterSec,
        blockedUntil,
        opType: payload.opType,
    };
    clearPendingNeedsInput();
    finalizeRunningTurns();
    scheduleTick();
    notify();
}

export function installRateLimitBridge(): () => void {
    return onPluginEvent('rate_limited', (payload) => {
        applyRateLimited(payload as { message?: string; retryAfterSec?: number; opType?: string });
    });
}

export function useRateLimitState(): RateLimitState | null {
    const [, bump] = useState(0);
    useEffect(() => {
        const sub = () => bump((n) => n + 1);
        listeners.add(sub);
        return () => {
            listeners.delete(sub);
        };
    }, []);
    return getRateLimitState();
}

export function secondsUntilUnblock(): number {
    const s = getRateLimitState();
    if (!s) return 0;
    return Math.max(0, Math.ceil((s.blockedUntil - Date.now()) / 1000));
}
