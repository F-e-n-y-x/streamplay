import { useSyncExternalStore } from "react";
import type { Card } from "./types";
import { getSettings, applyRemoteSettings, onSettingsChange, type ClientSettings } from "./settings";

/**
 * Unified local store for watch history + favourites, with optional real-time
 * multi-device sync. Lives in localStorage; when a sync code is set it mirrors
 * to the server room and applies live updates from other devices (LWW by updatedAt).
 */

export interface HistoryEntry {
  key: string;
  id: number;
  type: "movie" | "tv";
  title: string;
  posterUrl?: string;
  /** Landscape art for the Continue Watching cards (entries from older builds lack it). */
  backdropUrl?: string;
  season?: number;
  episode?: number;
  position: number;   // seconds watched
  duration: number;   // total seconds
  provider?: string;  // source/provider name
  sourceType?: string;
  updatedAt: number;
  /** Synthetic "next episode" entry from nextUp() — never stored. */
  upNext?: boolean;
}
export interface FavEntry extends Card { key: string; updatedAt: number; }
interface LocalData { history: Record<string, HistoryEntry>; favs: Record<string, FavEntry>; }

export type SyncState = "off" | "connecting" | "live" | "error";

export interface Device { id: string; name: string; online: boolean }

const DATA_KEY = "sp.data.v1";
const CODE_KEY = "sp.sync.code";
const DEVID_KEY = "sp.device.id";
const DEVNAME_KEY = "sp.device.name";

let data: LocalData = load();
let code: string | null = loadCode();
let es: EventSource | null = null;
let syncState: SyncState = "off";
let roster: Device[] = [];
let version = 0;

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? "Android" : /iphone|ipad|ipod/i.test(ua) ? "iOS" : /windows/i.test(ua) ? "Windows" : /mac/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "Device";
  const br = /edg/i.test(ua) ? "Edge" : /opr|opera/i.test(ua) ? "Opera" : /chrome/i.test(ua) ? "Chrome" : /firefox/i.test(ua) ? "Firefox" : /safari/i.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}
function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* */ } }

let deviceId = lsGet(DEVID_KEY) || "";
if (!deviceId) { deviceId = "d_" + Math.random().toString(36).slice(2, 10); lsSet(DEVID_KEY, deviceId); }
let deviceName = lsGet(DEVNAME_KEY) || defaultDeviceName();

export function getDeviceName() { return deviceName; }
export function getRoster() { return roster; }
export function setDeviceName(name: string) {
  deviceName = name.trim() || defaultDeviceName();
  lsSet(DEVNAME_KEY, deviceName);
  emit();
  if (code) fetch(`/api/sync/${encodeURIComponent(code)}/device`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: deviceId, name: deviceName }) }).catch(() => {});
}

const listeners = new Set<() => void>();
function emit() { version++; listeners.forEach((l) => l()); }
function subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
/** React hook: re-renders on any store change. Read data via the getters below. */
export function useStore() { return useSyncExternalStore(subscribe, () => version); }

function load(): LocalData {
  try { const d = JSON.parse(localStorage.getItem(DATA_KEY) || "{}"); return { history: d.history || {}, favs: d.favs || {} }; }
  catch { return { history: {}, favs: {} }; }
}
function save() { try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch { /* quota */ } }
function loadCode(): string | null { try { return localStorage.getItem(CODE_KEY); } catch { return null; } }

export function getSyncState() { return syncState; }
export function getSyncCode() { return code; }

// ── settings sync (LWW by updatedAt) ────────────────────────────────────────────
// We mirror the client settings object into the sync room too, so preferences
// (audio, quality, provider order/hide, sticky provider, WARP mode, …) follow you
// across devices — not just history/favourites.
let settingsSyncedAt = 0;
function pushSettings() {
  if (!code) return;
  const s = getSettings();
  fetch(`/api/sync/${encodeURIComponent(code)}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).catch(() => {});
}
function applyRemoteSettingsIfNewer(remote?: ClientSettings | null) {
  if (!remote || typeof remote.updatedAt !== "number") return;
  if (remote.updatedAt > getSettings().updatedAt) { settingsSyncedAt = remote.updatedAt; applyRemoteSettings(remote); }
}
// Push local settings changes to the room (skip the echo from applying a remote one).
onSettingsChange(() => {
  const s = getSettings();
  if (code && s.updatedAt > settingsSyncedAt) { settingsSyncedAt = s.updatedAt; pushSettings(); }
});

// ── history ───────────────────────────────────────────────────────────────────
const histKey = (type: string, id: number, season?: number, episode?: number) =>
  type === "tv" && season != null ? `tv-${id}-${season}-${episode}` : `${type}-${id}`;

export function putHistory(e: Omit<HistoryEntry, "key" | "updatedAt">) {
  const key = histKey(e.type, e.id, e.season, e.episode);
  const entry: HistoryEntry = { ...e, key, updatedAt: Date.now() };
  data.history[key] = entry; save(); emit(); pushEntry("history", entry);
}
export function getHistoryEntry(type: string, id: number, season?: number, episode?: number) {
  return data.history[histKey(type, id, season, episode)];
}
export function removeHistory(key: string) { delete data.history[key]; save(); emit(); pushRemove("history", key); }
export function clearHistory() { for (const k of Object.keys(data.history)) pushRemove("history", k); data.history = {}; save(); emit(); }

const isComplete = (h: HistoryEntry) => h.duration > 0 && h.position >= h.duration * 0.97;

/** Newest history entry for a show/movie (any episode) — the resume target. */
export function latestFor(type: string, id: number): HistoryEntry | undefined {
  let best: HistoryEntry | undefined;
  for (const h of Object.values(data.history)) if (h.type === type && h.id === id && (!best || h.updatedAt > best.updatedAt)) best = h;
  return best;
}

/**
 * The episode to play after a finished one (position 0, `upNext: true`), else null.
 * `seasons` (TitleDetail.seasons) lets it roll over into the next season; without it
 * it assumes episode+1 exists in the same season.
 */
export function nextUp(h: HistoryEntry, seasons?: { seasonNumber: number; episodeCount: number }[]): HistoryEntry | null {
  if (h.type !== "tv" || h.season == null || h.episode == null || !isComplete(h)) return null;
  let season = h.season, episode = h.episode + 1;
  const cur = seasons?.find((s) => s.seasonNumber === season);
  if (cur && cur.episodeCount > 0 && episode > cur.episodeCount) {
    const nxt = seasons!.filter((s) => s.seasonNumber > season && s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
    if (!nxt) return null;   // finished the show
    season = nxt.seasonNumber; episode = 1;
  }
  return { ...h, key: histKey("tv", h.id, season, episode), season, episode, position: 0, duration: 0, upNext: true };
}

/** Resume list, newest first, one card per show: the in-progress entry, "Up next" when its
 *  newest episode is finished, or a duration-0 "started" entry (embeds can't report progress). */
export function continueWatching(): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const h of Object.values(data.history).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const sk = `${h.type}-${h.id}`;
    if (seen.has(sk)) continue;
    seen.add(sk);
    if (h.duration <= 0) { out.push(h); continue; }   // embed ("started", no progress reported)
    const next = nextUp(h);
    if (next) out.push(next);
    else if (!isComplete(h)) out.push(h);   // any progress, even a few seconds
  }
  return out;
}
/** Watch-page URL for a history entry. */
export const watchHref = (h: Pick<HistoryEntry, "type" | "id" | "season" | "episode">) =>
  h.type === "tv" ? `/watch/tv/${h.id}/${h.season ?? 1}/${h.episode ?? 1}` : `/watch/movie/${h.id}`;

export function recentHistory(): HistoryEntry[] { return Object.values(data.history).sort((a, b) => b.updatedAt - a.updatedAt); }

// ── favourites ─────────────────────────────────────────────────────────────────
const favKey = (type: string, id: number) => `${type}-${id}`;
export function isFav(type: string, id: number) { return !!data.favs[favKey(type, id)]; }
export function listFavs(): FavEntry[] { return Object.values(data.favs).sort((a, b) => b.updatedAt - a.updatedAt); }
export function toggleFav(card: Card): boolean {
  const key = favKey(card.type, card.id);
  if (data.favs[key]) { delete data.favs[key]; save(); emit(); pushRemove("fav", key); return false; }
  const fav: FavEntry = { ...card, key, updatedAt: Date.now() };
  data.favs[key] = fav; save(); emit(); pushEntry("fav", fav); return true;
}

// ── sync ────────────────────────────────────────────────────────────────────────
async function checkCode(c: string): Promise<{ claimed: boolean; devices: number }> {
  const res = await fetch(`/api/sync/${encodeURIComponent(c)}/check`).catch(() => null);
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok) throw new Error(body?.error || "Can't reach the sync server.");
  return body;
}
/** Create a brand-new code (must be unique/unclaimed). Throws "taken" if already claimed. */
export async function createSync(c: string): Promise<void> {
  const code2 = c.trim();
  const st = await checkCode(code2);
  if (st.claimed) throw new Error("That code is already in use — pick another.");
  await linkDevice(code2);
}
/** Join an existing code (must already be claimed). Throws if it doesn't exist. */
export async function joinSync(c: string): Promise<void> {
  const code2 = c.trim();
  const st = await checkCode(code2);
  if (!st.claimed) throw new Error("No device has created that code yet.");
  await linkDevice(code2);
}
/** POST local data to the room and adopt the merged result. Throws the server's error text. */
async function seedRoom(c: string): Promise<void> {
  const res = await fetch(`/api/sync/${encodeURIComponent(c)}/bulk`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: data.history, favs: data.favs, settings: getSettings() }),
  });
  const merged = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(merged.error || `Sync server said ${res.status}.`);
  if (merged.history) data.history = merged.history;
  if (merged.favs) data.favs = merged.favs;
  save(); emit();
  applyRemoteSettingsIfNewer(merged.settings);
}
async function linkDevice(c: string): Promise<void> {
  syncState = "connecting"; emit();
  try { await seedRoom(c); }
  catch (e) { syncState = code ? "error" : "off"; emit(); throw e; }   // bad/weak code: don't adopt it
  code = c;
  lsSet(CODE_KEY, code);
  connectStream();
}
export function disableSync() {
  code = null;
  try { localStorage.removeItem(CODE_KEY); } catch { /* */ }
  if (es) { es.close(); es = null; }
  roster = []; syncState = "off"; emit();
}
/** Bridge our network with another existing code (transitive mesh merge). */
export async function bridgeCode(other: string): Promise<void> {
  if (!code) throw new Error("Create or join a code first.");
  const o = other.trim();
  if (!o) throw new Error("Enter a code to bridge.");
  const res = await fetch(`/api/sync/${encodeURIComponent(code)}/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ other: o }),
  });
  const r = await res.json().catch(() => ({ ok: false, error: "Network error." }));
  if (!r.ok) throw new Error(r.error || "Could not bridge that code.");
  // server pushes merged snapshot + roster over our existing stream
}
export function forgetDevice(id: string) {
  if (code) fetch(`/api/sync/${encodeURIComponent(code)}/device/forget`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: id }) }).catch(() => {});
}
function connectStream() {
  if (es) { es.close(); es = null; }
  if (!code) return;
  const q = new URLSearchParams({ device: deviceId, name: deviceName });
  es = new EventSource(`/api/sync/${encodeURIComponent(code)}/stream?${q.toString()}`);
  es.onopen = () => { syncState = "live"; emit(); };
  es.onerror = () => { syncState = "error"; emit(); };
  es.addEventListener("snapshot", (e) => mergeRemote(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("history", (e) => mergeOne("history", JSON.parse((e as MessageEvent).data)));
  es.addEventListener("fav", (e) => mergeOne("fav", JSON.parse((e as MessageEvent).data)));
  es.addEventListener("settings", (e) => applyRemoteSettingsIfNewer(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("roster", (e) => { roster = JSON.parse((e as MessageEvent).data); emit(); });
  es.addEventListener("remove", (e) => {
    const { kind, key, at } = JSON.parse((e as MessageEvent).data);
    const map = kind === "fav" ? data.favs : data.history;
    // LWW: don't drop a locally-newer entry to a stale remote delete.
    if (map[key] && at != null && map[key].updatedAt > at) return;
    delete map[key];
    save(); emit();
  });
}
function mergeRemote(s: { history?: Record<string, HistoryEntry>; favs?: Record<string, FavEntry>; settings?: ClientSettings | null }) {
  for (const e of Object.values(s.history || {})) { const c = data.history[e.key]; if (!c || e.updatedAt >= c.updatedAt) data.history[e.key] = e; }
  for (const e of Object.values(s.favs || {})) { const c = data.favs[e.key]; if (!c || e.updatedAt >= c.updatedAt) data.favs[e.key] = e; }
  save(); emit();
  applyRemoteSettingsIfNewer(s.settings);
}
function mergeOne(kind: "history" | "fav", e: HistoryEntry | FavEntry) {
  const map: Record<string, any> = kind === "fav" ? data.favs : data.history;
  const c = map[e.key];
  if (!c || e.updatedAt >= c.updatedAt) { map[e.key] = e; save(); emit(); }
}
function pushEntry(event: "history" | "fav", payload: any) {
  if (!code) return;
  fetch(`/api/sync/${encodeURIComponent(code)}/${event}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
}
function pushRemove(kind: "history" | "fav", key: string) {
  if (!code) return;
  // Send the delete time so the server/peers apply it LWW (a delete can't clobber a newer update).
  fetch(`/api/sync/${encodeURIComponent(code)}/remove`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, key, at: Date.now() }) }).catch(() => {});
}

/** 10 random [a-z0-9] chars (server requires >= 8 chars, >= 4 distinct for new codes). */
export function randomCode(): string {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";   // no 0/o/1/l lookalikes
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => abc[b % abc.length]).join("");
}

// Auto-resume on load: re-seed the room from local data (offline edits, reset server),
// then open the live stream. Offline is fine — the stream retries and snapshot-merges.
if (code) { syncState = "connecting"; seedRoom(code).catch(() => {}).finally(connectStream); }
