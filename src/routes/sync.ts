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
interface Room {
    history: Record<string, Entry>;
    favs: Record<string, Entry>;
    devices: Record<string, { name: string }>;
    claimed: boolean;
    clients: Map<Response, string>;  // res -> deviceId
}

const rooms = new Map<string, Room>();          // keyed by ROOT code
const parent: Record<string, string> = {};      // union-find: code -> parent code

const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, '..', '..', 'sync-data.json');
let saveTimer: NodeJS.Timeout | null = null;
const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        const out: any = { rooms: {}, parent };
        for (const [root, r] of rooms) out.rooms[root] = { history: r.history, favs: r.favs, devices: r.devices, claimed: r.claimed };
        fs.writeFile(DATA_FILE, JSON.stringify(out), () => { /* best effort */ });
    }, 1200);
};
(function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        const roomsObj = raw.rooms || raw; // tolerate the older flat format
        for (const code of Object.keys(roomsObj)) {
            const r = roomsObj[code];
            rooms.set(code, { history: r.history || {}, favs: r.favs || {}, devices: r.devices || {}, claimed: !!r.claimed, clients: new Map() });
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
function getRoom(code: string): Room {
    const root = find(code);
    let r = rooms.get(root);
    if (!r) { r = { history: {}, favs: {}, devices: {}, claimed: false, clients: new Map() }; rooms.set(root, r); }
    return r;
}

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
    for (const e of Object.values(B.history)) mergeEntry(A.history, e);
    for (const e of Object.values(B.favs)) mergeEntry(A.favs, e);
    for (const [id, d] of Object.entries(B.devices)) A.devices[id] = d;
    for (const [res, dev] of B.clients) A.clients.set(res, dev);
    B.clients.clear();
    A.claimed = A.claimed || B.claimed;
    parent[rb] = ra;
    rooms.delete(rb);
    scheduleSave();
    broadcast(A, 'snapshot', { history: A.history, favs: A.favs });
    broadcast(A, 'roster', rosterOf(A));
    return A;
}

// ── code availability ─────────────────────────────────────────────────────────
router.get('/:code/check', (req, res) => {
    const r = rooms.get(find(req.params.code));
    res.json({ claimed: !!(r && r.claimed), devices: r ? Object.keys(r.devices).length : 0 });
});

// ── full state ───────────────────────────────────────────────────────────────
router.get('/:code', (req, res) => {
    const r = getRoom(req.params.code);
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
    res.write(`event: snapshot\ndata: ${JSON.stringify({ history: r.history, favs: r.favs })}\n\n`);

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
    if (!target || !target.claimed) return res.json({ ok: false, error: 'No device has created that code yet.' });
    if (find(other) === find(req.params.code)) return res.json({ ok: false, error: 'Already in the same group.' });
    bridge(req.params.code, other);
    res.json({ ok: true });
});

// ── bulk seed/merge ──────────────────────────────────────────────────────────
router.post('/:code/bulk', (req, res) => {
    const r = getRoom(req.params.code);
    const { history = {}, favs = {} } = req.body || {};
    for (const e of Object.values(history) as Entry[]) mergeEntry(r.history, e);
    for (const e of Object.values(favs) as Entry[]) mergeEntry(r.favs, e);
    scheduleSave();
    broadcast(r, 'snapshot', { history: r.history, favs: r.favs });
    res.json({ history: r.history, favs: r.favs });
});

// ── upserts ──────────────────────────────────────────────────────────────────
router.post('/:code/history', (req, res) => {
    const r = getRoom(req.params.code);
    if (mergeEntry(r.history, req.body)) { scheduleSave(); broadcast(r, 'history', r.history[req.body.key]); }
    res.json({ ok: true });
});
router.post('/:code/fav', (req, res) => {
    const r = getRoom(req.params.code);
    if (mergeEntry(r.favs, req.body)) { scheduleSave(); broadcast(r, 'fav', r.favs[req.body.key]); }
    res.json({ ok: true });
});
router.post('/:code/remove', (req, res) => {
    const r = getRoom(req.params.code);
    const { kind, key } = req.body || {};
    const map = kind === 'fav' ? r.favs : r.history;
    if (map[key]) { delete map[key]; scheduleSave(); broadcast(r, 'remove', { kind, key }); }
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
