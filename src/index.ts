import 'dotenv/config';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import compression from 'compression';
import proxyRoutes from './routes/proxy';
import webRoutes from './routes/web';
import syncRoutes from './routes/sync';
import torrentRoutes from './routes/torrent';
import addonsRoutes from './routes/addons';

const app = express();
// Behind a reverse proxy set TRUST_PROXY (e.g. 1 or "loopback") so rate limits see real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
const PORT = process.env.PORT || 3000;

// No global CORS: the React client is same-origin (Vite proxies /api in dev). The
// media routes (/api/proxy, /api/torrent) set their own ACAO for <video>/Chromecast.
// JSON only: a cross-site HTML form can't send it without a CORS preflight, which we never grant.
app.use(express.json());
// …and refuse non-JSON POSTs outright: a cross-site <form> post would otherwise arrive
// with an empty body, which some routes read as "clear" (e.g. /config/torznab).
app.use('/api', (req, res, next) => (req.method === 'POST' && !req.is('application/json') ? res.status(415).json({ error: 'JSON body required' }) : next()));

// ── Optional shared secret (STREAMPLAY_PASSWORD). Off by default. ─────────────
// Open `/?key=<password>` once per browser: it sets an HttpOnly cookie. Scripts can
// send the `x-streamplay-key` header instead. Gates every /api/* route.
// ponytail: media URLs handed to Chromecast/other devices carry no cookie, so casting
// proxied streams needs the receiver on an authenticated origin; add signed URLs if needed.
const PASSWORD = process.env.STREAMPLAY_PASSWORD;
if (PASSWORD) {
    const digest = (v: string) => crypto.createHash('sha256').update(v).digest();
    const ok = (v: unknown) => typeof v === 'string' && crypto.timingSafeEqual(digest(v), digest(PASSWORD));
    // the cookie holds an HMAC of the password, never the password itself
    const session = crypto.createHmac('sha256', PASSWORD).update('streamplay-session').digest('hex');
    const okSession = (v: unknown) => typeof v === 'string' && crypto.timingSafeEqual(digest(v), digest(session));
    const cookieKey = (req: express.Request) => {
        const m = /(?:^|;\s*)sp_key=([^;]*)/.exec(req.headers.cookie || '');
        try { return m ? decodeURIComponent(m[1]) : undefined; } catch { return undefined; }
    };
    app.use((req, res, next) => {
        if (ok(req.query.key)) {
            res.cookie('sp_key', session, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 864e5 });
            return res.redirect('/' + req.path.replace(/^\/+/, ''));   // no `//host` open redirect
        }
        // Express routing is case-insensitive, so the gate must be too (`/API/...` reaches the API)
        if (!/^\/api(\/|$)/i.test(req.path) || ok(req.headers['x-streamplay-key']) || okSession(cookieKey(req))) return next();
        res.status(401).json({ error: 'unauthorized' });
    });
}

app.use('/api/proxy', proxyRoutes);
app.use('/api/torrent', torrentRoutes);   // WebTorrent streaming (torrent mode)
app.use('/api/sync', syncRoutes);   // multi-device history + favourites sync
app.use('/api/addons', addonsRoutes);   // addon catalog / manifest inspect / per-scraper toggles
app.use('/api', webRoutes);   // primary API for the React client (home/title/search/sources SSE…)

// ── Serve the built React client (client/dist) ────────────────────────────────
// gzip the UI bundle only; /api streams (proxy/torrent/SSE) must stay unbuffered.
const compress = compression();
app.use((req, res, next) => (req.path.startsWith('/api') ? next() : compress(req, res, next)));
const uiRoot = path.join(__dirname, '..', 'client', 'dist');

// Vite emits content-hashed asset filenames, so those can cache forever; but
// index.html must NOT be cached or the browser keeps loading the OLD bundle after
// a rebuild (the "I redeployed but the UI is unchanged" trap).
app.use(express.static(uiRoot, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        else if (/[-.][0-9a-zA-Z_]{8,}\.(js|css|woff2?|png|svg|jpg|jpeg|webp)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
}));
// SPA fallback: any non-API route serves index.html so client-side routing works.
// Anchor the exclusion on the mount boundary (`/api/` OR bare `/api`) so a future
// endpoint like `/api` or `/api-docs` isn't silently shadowed by the SPA index.html.
app.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(uiRoot, 'index.html'));
});

// Error handling: honour an error's HTTP status (body-parser 400/413, sync 400/503…);
// only 4xx messages are shown to the client — 5xx details stay in the log.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const s = Number(err?.status || err?.statusCode);
    const status = s >= 400 && s < 600 ? s : 500;
    if (status >= 500) console.error(err?.stack || err);
    res.status(status).json({ error: status < 500 ? err.message : 'Internal Server Error' });
});

app.listen(PORT, () => {
    console.log(`StreamPlay running on http://localhost:${PORT}`);
});
