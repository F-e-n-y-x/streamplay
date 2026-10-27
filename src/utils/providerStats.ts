import { dataFile, readJson, writeJsonAtomic } from './common';

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
    // Playback (client reports) — separate from "returned streams" above: a provider can
    // return links all day that never play. Rings hold the last RECENT_N outcomes (1 = ok).
    playOk: number; playFail: number;
    recentPlay: number[];
    recentVerify: number[];     // per provider run: did ANY of its links pass the playability probe
    ttffMs: number;             // EMA of time-to-first-frame from 'played' reports
    lastPlayError?: string;
    hiddenUntil: number;        // epoch ms; >now = chronically failing → sources flagged hidden, sorted last
}

const FAIL_THRESHOLD = 4;                 // consecutive failures to trip the breaker
const COOLDOWN_MS = 10 * 60 * 1000;       // stay broken this long, then half-open probe
// Hiding: over the last RECENT_N outcomes (≥ MIN_SAMPLES), a playback or verification
// success rate below HIDE_RATE hides the provider for HIDE_MS. The rings are cleared on
// hide so it comes back with a clean slate (and re-hides quickly if still broken).
const RECENT_N = 10, MIN_SAMPLES = 4, HIDE_RATE = 0.25;
const HIDE_MS = 30 * 60 * 1000;

const stats = new Map<string, Stat>();
const blank = (): Stat => ({
    successCount: 0, failureCount: 0, emptyCount: 0, consecutiveFailures: 0, totalMs: 0, timedRuns: 0, circuitOpenUntil: 0, lastAt: 0,
    playOk: 0, playFail: 0, recentPlay: [], recentVerify: [], ttffMs: 0, hiddenUntil: 0,
});
const get = (id: string): Stat => { let s = stats.get(id); if (!s) { s = blank(); stats.set(id, s); } return s; };

// Optional persistence so health survives a restart (same dir as sync-data).
const FILE = process.env.PROVIDER_STATS_FILE || dataFile('provider-stats.json');
let saveTimer: NodeJS.Timeout | null = null;
const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeJsonAtomic(FILE, [...stats]);
    }, 5000);
    saveTimer.unref?.();
};
(function load() {
    try { for (const [id, s] of readJson(FILE) || []) stats.set(id, { ...blank(), ...s }); } catch { /* wrong shape → start fresh */ }
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
        // empty = reachable, just no match → not a failure. Also closes the breaker: a
        // half-open probe that came back empty proved the provider is alive.
        s.emptyCount++; s.consecutiveFailures = 0; s.circuitOpenUntil = 0;
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

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 1);
const pushRing = (s: Stat, ring: 'recentPlay' | 'recentVerify', ok: boolean) => {
    s[ring].push(ok ? 1 : 0);
    if (s[ring].length > RECENT_N) s[ring].shift();
    if (s.hiddenUntil > Date.now()) return;
    if ((['recentPlay', 'recentVerify'] as const).some((r) => s[r].length >= MIN_SAMPLES && avg(s[r]) < HIDE_RATE)) {
        s.hiddenUntil = Date.now() + HIDE_MS;
        s.recentPlay = []; s.recentVerify = [];
    }
};

/** A client playback report (POST /sources/report). 'stalled' counts as a failure. */
export function recordPlayback(id: string, outcome: 'played' | 'failed' | 'stalled', ttffMs?: number, error?: string): void {
    const s = get(id);
    const ok = outcome === 'played';
    if (ok) { s.playOk++; if (ttffMs) s.ttffMs = s.ttffMs ? Math.round(s.ttffMs * 0.7 + ttffMs * 0.3) : ttffMs; }
    else { s.playFail++; if (error) s.lastPlayError = error.slice(0, 120); }
    pushRing(s, 'recentPlay', ok);
    scheduleSave();
}

/** One provider run's probe verdict: true if any link verified, false if all probed links failed. */
export function recordVerify(id: string, ok: boolean): void {
    pushRing(get(id), 'recentVerify', ok);
    scheduleSave();
}

export const providerHidden = (id: string): boolean => (stats.get(id)?.hiddenUntil || 0) > Date.now();

/** 0..1 for scoring: smoothed recent playback rate (prior ≈ 2/3 for an untested provider)
 *  weighted 70/30 with the "returned streams" success rate. */
export function providerReliability(id: string): number {
    const s = stats.get(id);
    if (!s) return 2 / 3 * 0.7 + 0.3;
    const play = (s.recentPlay.reduce((x, y) => x + y, 0) + 2) / (s.recentPlay.length + 3);
    const total = s.successCount + s.failureCount;
    return play * 0.7 + (total ? s.successCount / total : 1) * 0.3;
}

export interface ProviderStat {
    successRate: number; avgTimeMs: number; isCircuitBroken: boolean;
    successCount: number; failureCount: number; consecutiveFailures: number;
    playbackRate: number | null; playbackAttempts: number; verifyRate: number | null; ttffMs: number;
    hidden: boolean; hiddenUntil: number; reliability: number;
}
export function providerStat(id: string): ProviderStat {
    const s = stats.get(id) || blank();
    const total = s.successCount + s.failureCount;
    return {
        successRate: total ? s.successCount / total : 1,
        avgTimeMs: s.timedRuns ? Math.round(s.totalMs / s.timedRuns) : 0,
        isCircuitBroken: s.circuitOpenUntil > Date.now(),
        successCount: s.successCount, failureCount: s.failureCount, consecutiveFailures: s.consecutiveFailures,
        playbackRate: s.recentPlay.length ? avg(s.recentPlay) : null, playbackAttempts: s.playOk + s.playFail,
        verifyRate: s.recentVerify.length ? avg(s.recentVerify) : null, ttffMs: s.ttffMs,
        hidden: s.hiddenUntil > Date.now(), hiddenUntil: s.hiddenUntil > Date.now() ? s.hiddenUntil : 0,
        reliability: Math.round(providerReliability(id) * 100) / 100,
    };
}

/** Priority score for ranking/UX: reliability (0..100) minus circuit-broken / hidden penalties. */
export function providerPriority(id: string): number {
    const st = providerStat(id);
    return Math.round(st.reliability * 100) - (st.isCircuitBroken ? 1000 : 0) - (st.hidden ? 500 : 0);
}
