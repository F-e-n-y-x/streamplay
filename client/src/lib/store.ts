import { useSyncExternalStore } from "react";
import type { Card } from "./types";

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
  season?: number;
  episode?: number;
  position: number;   // seconds watched
  duration: number;   // total seconds
  provider?: string;  // source/provider name
  sourceType?: string;
  updatedAt: number;
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

/** Resume list: partially-watched, newest first, one row per show. */
export function continueWatching(): HistoryEntry[] {
  const all = Object.values(data.history)
    .filter((h) => h.duration > 0 && h.position > 5 && h.position < h.duration * 0.97)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const h of all) { const sk = `${h.type}-${h.id}`; if (seen.has(sk)) continue; seen.add(sk); out.push(h); }
  return out;
}
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
export async function checkCode(c: string): Promise<{ claimed: boolean; devices: number }> {
  try { const res = await fetch(`/api/sync/${encodeURIComponent(c.trim())}/check`); return await res.json(); }
  catch { return { claimed: false, devices: 0 }; }
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
async function linkDevice(c: string): Promise<void> {
  code = c;
  lsSet(CODE_KEY, code);
  syncState = "connecting"; emit();
  try {
    const res = await fetch(`/api/sync/${encodeURIComponent(code)}/bulk`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: data.history, favs: data.favs }),
    });
    const merged = await res.json();
    if (merged.history) data.history = merged.history;
    if (merged.favs) data.favs = merged.favs;
    save(); emit();
  } catch { syncState = "error"; emit(); }
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
  es.addEventListener("roster", (e) => { roster = JSON.parse((e as MessageEvent).data); emit(); });
  es.addEventListener("remove", (e) => {
    const { kind, key } = JSON.parse((e as MessageEvent).data);
    if (kind === "fav") delete data.favs[key]; else delete data.history[key];
    save(); emit();
  });
}
function mergeRemote(s: { history?: Record<string, HistoryEntry>; favs?: Record<string, FavEntry> }) {
  for (const e of Object.values(s.history || {})) { const c = data.history[e.key]; if (!c || e.updatedAt >= c.updatedAt) data.history[e.key] = e; }
  for (const e of Object.values(s.favs || {})) { const c = data.favs[e.key]; if (!c || e.updatedAt >= c.updatedAt) data.favs[e.key] = e; }
  save(); emit();
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
  fetch(`/api/sync/${encodeURIComponent(code)}/remove`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, key }) }).catch(() => {});
}

export function randomCode(): string {
  return (Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)).toLowerCase();
}

// auto-connect on load if a code is stored
if (code) connectStream();
