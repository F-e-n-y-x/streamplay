import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import apiRoutes from './routes';
import proxyRoutes from './routes/proxy';
import webRoutes from './routes/web';
import syncRoutes from './routes/sync';
import torrentRoutes from './routes/torrent';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/proxy', proxyRoutes);
app.use('/api/torrent', torrentRoutes);   // WebTorrent streaming (torrent mode)
app.use('/api/sync', syncRoutes);   // multi-device history + favourites sync
app.use('/api', webRoutes);   // primary API for the React client (home/title/search/sources SSE…)
app.use('/api', apiRoutes);   // legacy endpoints (/info, /streams, /providers/status) kept for compatibility

// ── Serve the built React client (client/dist), falling back to the legacy public/ UI ──
const clientDist = path.join(__dirname, '..', 'client', 'dist');
const legacyPublic = path.join(__dirname, '..', 'public');
const uiRoot = fs.existsSync(path.join(clientDist, 'index.html')) ? clientDist : legacyPublic;

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
app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(uiRoot, 'index.html'));
});

// Error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(PORT, () => {
    console.log(`StreamPlay running on http://localhost:${PORT}  (UI: ${uiRoot === clientDist ? 'React client' : 'legacy public'})`);
});
