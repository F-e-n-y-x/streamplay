import fs from 'fs';
import path from 'path';

/**
 * Per-provider health + circuit-breaker.
 *
 * The SSE fan-out records each provider's outcome (found / empty / failed) here. We
 * derive a real success rate + average latency (the /providers page used to show a
 * hard-coded 100%), and — crucially — a CIRCUIT BREAKER: a provider that errors/times
 * out repeatedly is skipped for a cooldown so it stops wasting a FlareSolverr slot and
 * PROVIDER_TIMEOUT_MS on every request. A single half-open probe after the cooldown
 * lets it recover automatically.
 *
 *   found  → success (reachable + produced a stream)
 *   empty  → reachable but no match for this title (NOT a health problem)
 *   failed → error or timeout (the signal the breaker trips on)
 */

interface Stat {
    successCount: number;
    failureCount: number;
    emptyCount: number;
    consecutiveFailures: number;
    totalMs: number;      // sum of durations of SUCCESSFUL runs (for avg latency)
    timedRuns: number;
    circuitOpenUntil: number;   // epoch ms; >now = broken (skipped)
    lastOutcome?: 'found' | 'empty' | 'failed';
    lastAt: number;
}

const FAIL_THRESHOLD = 4;                 // consecutive failures to trip the breaker
const COOLDOWN_MS = 10 * 60 * 1000;       // stay broken this long, then half-open probe

const stats = new Map<string, Stat>();
const blank = (): Stat => ({ successCount: 0, failureCount: 0, emptyCount: 0, consecutiveFailures: 0, totalMs: 0, timedRuns: 0, circuitOpenUntil: 0, lastAt: 0 });
const get = (id: string): Stat => { let s = stats.get(id); if (!s) { s = blank(); stats.set(id, s); } return s; };

// Optional persistence so health survives a restart (same dir as sync-data).
const FILE = process.env.PROVIDER_STATS_FILE || path.join(path.dirname(process.env.SYNC_DATA_FILE || './x'), 'provider-stats.json');
let saveTimer: NodeJS.Timeout | null = null;
const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try { fs.writeFile(FILE, JSON.stringify([...stats]), () => { /* best effort */ }); } catch { /* */ }
    }, 5000);
    saveTimer.unref?.();
};
(function load() {
    try { for (const [id, s] of JSON.parse(fs.readFileSync(FILE, 'utf-8'))) stats.set(id, { ...blank(), ...s }); } catch { /* no file yet */ }
})();

/** Record a provider run's outcome. */
export function recordProvider(id: string, outcome: 'found' | 'empty' | 'failed', durationMs: number): void {
    const s = get(id);
    s.lastOutcome = outcome; s.lastAt = Date.now();
    if (outcome === 'found') {
        s.successCount++; s.consecutiveFailures = 0; s.circuitOpenUntil = 0;   // recovered → close breaker
        s.totalMs += durationMs; s.timedRuns++;
    } else if (outcome === 'failed') {
        s.failureCount++; s.consecutiveFailures++;
        if (s.consecutiveFailures >= FAIL_THRESHOLD) s.circuitOpenUntil = Date.now() + COOLDOWN_MS;
    } else {
        s.emptyCount++; s.consecutiveFailures = 0;   // empty = reachable, just no match → not a failure
    }
    scheduleSave();
}

/** Should this provider run now? False while its breaker is open (within cooldown).
 *  Once the cooldown elapses we allow ONE half-open probe (and re-arm the cooldown so
 *  a still-dead provider doesn't get probed on every concurrent request). */
export function providerShouldRun(id: string): boolean {
    const s = stats.get(id);
    if (!s || !s.circuitOpenUntil) return true;
    if (Date.now() < s.circuitOpenUntil) return false;
    s.circuitOpenUntil = Date.now() + COOLDOWN_MS;   // half-open: allow this one, re-arm
    return true;
}

export interface ProviderStat {
    successRate: number; avgTimeMs: number; isCircuitBroken: boolean;
    successCount: number; failureCount: number; consecutiveFailures: number;
}
export function providerStat(id: string): ProviderStat {
    const s = stats.get(id);
    if (!s) return { successRate: 1, avgTimeMs: 0, isCircuitBroken: false, successCount: 0, failureCount: 0, consecutiveFailures: 0 };
    const total = s.successCount + s.failureCount;
    return {
        successRate: total ? s.successCount / total : 1,
        avgTimeMs: s.timedRuns ? Math.round(s.totalMs / s.timedRuns) : 0,
        isCircuitBroken: s.circuitOpenUntil > Date.now(),
        successCount: s.successCount, failureCount: s.failureCount, consecutiveFailures: s.consecutiveFailures,
    };
}

/** Priority score for ranking/UX: success rate (0..100) minus a circuit-broken penalty. */
export function providerPriority(id: string): number {
    const st = providerStat(id);
    return Math.round(st.successRate * 100) - (st.isCircuitBroken ? 1000 : 0);
}
