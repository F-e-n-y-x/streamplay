import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Multi-device sync for watch history + favourites, with a live device roster
 * and **transitive bridging**.
 *
 * A "sync code" is a room. Devices that share a code see each other. Codes can
 * also be *bridged*: bridging code A and code B merges their rooms (union-find),
 * so if A↔B and B↔C are bridged, A, B and C all share one library and roster —
 * even though A and C never shared a code directly.
 *
 * State + roster + the bridge graph persist to disk. Entries merge LWW by updatedAt.
 */
const router = Router();

interface Entry { key: string; updatedAt: number; [k: string]: any; }
interface Settings { updatedAt: number; [k: string]: any; }
interface Room {
    history: Record<string, Entry>;
    favs: Record<string, Entry>;
    settings: Settings | null;       // shared client settings (LWW by updatedAt)
    devices: Record<string, { name: string }>;
    claimed: boolean;
    clients: Map<Response, string>;  // res -> deviceId
    /** Deletion tombstones: `${kind}:${key}` -> deletedAt. Lets a delete win LWW
     *  against a stale re-add, and stops a delete from clobbering a NEWER update. */
    tomb: Record<string, number>;
}

const rooms = new Map<string, Room>();          // keyed by ROOT code
const parent: Record<string, string> = {};      // union-find: code -> parent code

const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, '..', '..', 'sync-data.json');
let saveTimer: NodeJS.Timeout | null = null;
let writing = false;
let dirty = false;
const doSave = () => {
    saveTimer = null;
    if (writing) { dirty = true; return; }   // a write is in flight — re-run after it
    writing = true; dirty = false;
    const out: any = { rooms: {}, parent };
    for (const [root, r] of rooms) out.rooms[root] = { history: r.history, favs: r.favs, settings: r.settings, devices: r.devices, claimed: r.claimed, tomb: pruneTomb(r.tomb) };
    // Write to a temp file then atomically rename, so a crash or an overlapping
    // write can never leave a half-written (unparseable) sync-data.json.
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(out), (err) => {
        if (!err) { try { fs.renameSync(tmp, DATA_FILE); } catch { /* best effort */ } }
        writing = false;
        if (dirty) scheduleSave();
    });
};
const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(doSave, 1200);
};
(function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        const roomsObj = raw.rooms || raw; // tolerate the older flat format
        for (const code of Object.keys(roomsObj)) {
            const r = roomsObj[code];
            rooms.set(code, { history: r.history || {}, favs: r.favs || {}, settings: r.settings || null, devices: r.devices || {}, claimed: !!r.claimed, clients: new Map(), tomb: r.tomb || {} });
        }
        Object.assign(parent, raw.parent || {});
    } catch { /* no file yet */ }
})();

// ── union-find over codes ─────────────────────────────────────────────────────
function find(code: string): string {
    let c = code;
    while (parent[c] && parent[c] !== c) c = parent[c];
    let x = code;
    while (parent[x] && parent[x] !== c) { const n = parent[x]; parent[x] = c; x = n; }
    return c;
}
const EMPTY_ROOM = (): Room => ({ history: {}, favs: {}, settings: null, devices: {}, claimed: false, clients: new Map(), tomb: {} });
// Cap the number of distinct rooms held in memory/persisted so a flood of requests
// with random codes can't grow the map (and sync-data.json) without bound. Only
// UNCLAIMED, empty rooms are evicted, so real libraries are never dropped.
const MAX_ROOMS = 5000;
function getRoom(code: string): Room {
    const root = find(code);
    let r = rooms.get(root);
    if (!r) {
        if (rooms.size >= MAX_ROOMS) {
            for (const [k, v] of rooms) {
                if (!v.claimed && !v.clients.size && !Object.keys(v.history).length && !Object.keys(v.favs).length) { rooms.delete(k); break; }
            }
        }
        r = EMPTY_ROOM(); rooms.set(root, r);
    }
    return r;
}
/** Read a room WITHOUT creating one — for GET endpoints, so merely querying an
 *  unknown code can't spawn (and persist) an empty room. */
const peekRoom = (code: string): Room | undefined => rooms.get(find(code));

// ── deletion tombstones ───────────────────────────────────────────────────────
const TOMB_TTL = 30 * 24 * 60 * 60 * 1000;  // keep tombstones 30 days, then prune
const tkey = (kind: string, key: string) => `${kind === 'fav' ? 'f' : 'h'}:${key}`;
const pruneTomb = (t: Record<string, number>): Record<string, number> => {
    const cutoff = Date.now() - TOMB_TTL;
    const out: Record<string, number> = {};
    for (const [k, at] of Object.entries(t)) if (at >= cutoff) out[k] = at;
    return out;
};

/** LWW upsert that also respects the tombstone (won't resurrect a more-recently-deleted key). */
const upsert = (room: Room, kind: 'history' | 'fav', entry: Entry): boolean => {
    if (!entry || !entry.key) return false;
    const map = kind === 'fav' ? room.favs : room.history;
    if ((entry.updatedAt || 0) <= (room.tomb[tkey(kind, entry.key)] || 0)) return false; // deleted more recently
    const cur = map[entry.key];
    if (!cur || (entry.updatedAt || 0) >= (cur.updatedAt || 0)) { map[entry.key] = entry; return true; }
    return false;
};

/** Delete `key` unless a NEWER update exists; records the tombstone at time `at`. */
const tombstone = (room: Room, kind: 'history' | 'fav', key: string, at: number): boolean => {
    const map = kind === 'fav' ? room.favs : room.history;
    const cur = map[key];
    if (cur && (cur.updatedAt || 0) > at) return false;   // a newer update wins over this stale delete
    delete map[key];
    const tk = tkey(kind, key);
    if (at > (room.tomb[tk] || 0)) room.tomb[tk] = at;
    return true;
};

/** Merge an incoming settings object LWW. Returns true if it became the room's. */
const mergeSettings = (room: Room, s: Settings | undefined | null): boolean => {
    if (!s || typeof s.updatedAt !== 'number') return false;
    if (!room.settings || s.updatedAt >= room.settings.updatedAt) { room.settings = s; return true; }
    return false;
};

const onlineIds = (room: Room) => new Set(room.clients.values());
const rosterOf = (room: Room) => {
    const online = onlineIds(room);
    return Object.entries(room.devices).map(([id, d]) => ({ id, name: d.name, online: online.has(id) }));
};
const broadcast = (room: Room, event: string, data: any) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of room.clients.keys()) { try { c.write(payload); } catch { /* drop */ } }
};
const mergeEntry = (map: Record<string, Entry>, entry: Entry): boolean => {
    if (!entry || !entry.key) return false;
    const cur = map[entry.key];
    if (!cur || (entry.updatedAt || 0) >= (cur.updatedAt || 0)) { map[entry.key] = entry; return true; }
    return false;
};

/** Merge code b's component into code a's component. */
function bridge(a: string, b: string): Room {
    const ra = find(a), rb = find(b);
    const A = getRoom(ra);
    if (ra === rb) return A;
    const B = getRoom(rb);
    // Merge tombstones FIRST (max time) so the entry merge below can't resurrect a
    // key that was deleted more recently in the other component.
    for (const [k, at] of Object.entries(B.tomb)) if (at > (A.tomb[k] || 0)) A.tomb[k] = at;
    for (const e of Object.values(B.history)) upsert(A, 'history', e);
    for (const e of Object.values(B.favs)) upsert(A, 'fav', e);
    for (const [id, d] of Object.entries(B.devices)) A.devices[id] = d;
    for (const [res, dev] of B.clients) A.clients.set(res, dev);
    B.clients.clear();
    mergeSettings(A, B.settings);
    A.claimed = A.claimed || B.claimed;
    parent[rb] = ra;
    rooms.delete(rb);
    scheduleSave();
    broadcast(A, 'snapshot', { history: A.history, favs: A.favs, settings: A.settings });
    broadcast(A, 'roster', rosterOf(A));
    return A;
}

// ── code availability ─────────────────────────────────────────────────────────
router.get('/:code/check', (req, res) => {
    const r = rooms.get(find(req.params.code));
    res.json({ claimed: !!(r && r.claimed), devices: r ? Object.keys(r.devices).length : 0 });
});

// ── full state (read-only: never creates/persists a room) ─────────────────────
router.get('/:code', (req, res) => {
    const r = peekRoom(req.params.code);
    if (!r) return res.json({ history: {}, favs: {}, devices: [] });
    res.json({ history: r.history, favs: r.favs, devices: rosterOf(r) });
});

// ── real-time stream (registers the device) ──────────────────────────────────
router.get('/:code/stream', (req, res) => {
    const r = getRoom(req.params.code);
    const deviceId = (req.query.device as string) || 'unknown';
    const name = (req.query.name as string) || 'Device';
    r.claimed = true;
    r.devices[deviceId] = { name };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ history: r.history, favs: r.favs, settings: r.settings })}\n\n`);

    r.clients.set(res, deviceId);
    scheduleSave();
    broadcast(r, 'roster', rosterOf(r));

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => {
        clearInterval(ping);
        const room = getRoom(req.params.code);
        room.clients.delete(res);
        broadcast(room, 'roster', rosterOf(room));
    });
});

// ── bridge two codes (transitive merge) ──────────────────────────────────────
router.post('/:code/bridge', (req, res) => {
    const other = ((req.body && req.body.other) || '').trim();
    if (!other) return res.json({ ok: false, error: 'No code given.' });
    const target = rooms.get(find(other));
    const targetKnown = target && (target.claimed || Object.keys(target.devices).length > 0);
    if (!targetKnown) return res.json({ ok: false, error: 'No device has created that code yet.' });
    if (find(other) === find(req.params.code)) return res.json({ ok: false, error: 'Already in the same group.' });
    bridge(req.params.code, other);
    res.json({ ok: true });
});

// ── bulk seed/merge ──────────────────────────────────────────────────────────
router.post('/:code/bulk', (req, res) => {
    const r = getRoom(req.params.code);
    const { history = {}, favs = {}, settings } = req.body || {};
    for (const e of Object.values(history) as Entry[]) upsert(r, 'history', e);
    for (const e of Object.values(favs) as Entry[]) upsert(r, 'fav', e);
    mergeSettings(r, settings);
    scheduleSave();
    broadcast(r, 'snapshot', { history: r.history, favs: r.favs, settings: r.settings });
    res.json({ history: r.history, favs: r.favs, settings: r.settings });
});

// ── upserts ──────────────────────────────────────────────────────────────────
router.post('/:code/history', (req, res) => {
    const r = getRoom(req.params.code);
    if (upsert(r, 'history', req.body)) { scheduleSave(); broadcast(r, 'history', r.history[req.body.key]); }
    res.json({ ok: true });
});
router.post('/:code/fav', (req, res) => {
    const r = getRoom(req.params.code);
    if (upsert(r, 'fav', req.body)) { scheduleSave(); broadcast(r, 'fav', r.favs[req.body.key]); }
    res.json({ ok: true });
});
router.post('/:code/settings', (req, res) => {
    const r = getRoom(req.params.code);
    if (mergeSettings(r, req.body)) { scheduleSave(); broadcast(r, 'settings', r.settings); }
    res.json({ ok: true });
});
router.post('/:code/remove', (req, res) => {
    const r = getRoom(req.params.code);
    const { kind, key } = req.body || {};
    const at = Number(req.body?.at) || Date.now();
    if (key && tombstone(r, kind === 'fav' ? 'fav' : 'history', key, at)) {
        scheduleSave();
        broadcast(r, 'remove', { kind, key, at });
    }
    res.json({ ok: true });
});

// ── device roster ────────────────────────────────────────────────────────────
router.post('/:code/device', (req, res) => {
    const r = getRoom(req.params.code);
    const { device, name } = req.body || {};
    if (device && name) { r.devices[device] = { name }; scheduleSave(); broadcast(r, 'roster', rosterOf(r)); }
    res.json({ ok: true });
});
router.post('/:code/device/forget', (req, res) => {
    const r = getRoom(req.params.code);
    const { device } = req.body || {};
    if (device && r.devices[device]) { delete r.devices[device]; scheduleSave(); broadcast(r, 'roster', rosterOf(r)); }
    res.json({ ok: true });
});

export default router;
