/* StreamPlay — views, routing, source manifest. Player lives in player.js. */
(function () {
    'use strict';

    const $view = document.getElementById('view');
    const $search = document.getElementById('search');
    const $toasts = document.getElementById('toasts');

    const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

    const ICON = {
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
        back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>',
        film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.2"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
        cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M8.5 10a2 2 0 1 0 0 4"></path><path d="M15.5 10a2 2 0 1 0 0 4"></path></svg>',
    };

    function toast(msg, kind = '') {
        const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
        $toasts.appendChild(t);
        setTimeout(() => { t.style.transition = 'opacity .2s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 3200);
    }

    async function api(path) {
        const r = await fetch('/api' + path);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    const img = (url, alt, cls) => url
        ? `<img class="${cls || ''}" loading="lazy" src="${esc(url)}" alt="${esc(alt)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:${JSON.stringify(alt || '')}}))" />`
        : `<div class="ph">${esc(alt || '')}</div>`;

    // ── browse ────────────────────────────────────────────────────────────────
    function renderHero() {
        destroyPlayer();
        $view.innerHTML = '';
        const hero = el(`
            <div class="page"><div class="hero">
                <div class="eyebrow">Personal cinema console</div>
                <h1 class="marquee">Find it. <em>Project</em> it.<br>From every source.</h1>
                <p>Search any film or show, then pull playable streams and subtitles from dozens of providers at once.</p>
                <form class="hero-search" id="heroForm" role="search">
                    ${ICON.search}
                    <input id="heroInput" type="search" placeholder="Try “Interstellar” or “Breaking Bad”…" autocomplete="off" />
                </form>
                <div class="hint">↵ to search · esc to clear</div>
            </div></div>`);
        $view.appendChild(hero);
        const hi = hero.querySelector('#heroInput');
        hero.querySelector('#heroForm').addEventListener('submit', (e) => { e.preventDefault(); $search.value = hi.value; runSearch(hi.value.trim()); hi.blur(); });
        hi.addEventListener('input', (e) => { $search.value = e.target.value; liveSearch(e.target.value.trim()); });
        setTimeout(() => hi.focus(), 50);
    }

    function renderSkeletons() {
        destroyPlayer();
        const grid = el('<div class="grid"></div>');
        for (let i = 0; i < 14; i++) grid.appendChild(el('<div class="skel poster-skel"></div>'));
        $view.innerHTML = '';
        const page = el('<div class="page"></div>');
        page.appendChild(el(`<div class="section-h"><h2>Searching…</h2><span class="meta"><span class="spinner" style="display:inline-block;vertical-align:-3px"></span></span></div>`));
        page.appendChild(grid);
        $view.appendChild(page);
    }

    let lastResults = null;
    function renderResults(query, items) {
        destroyPlayer();
        lastResults = { query, items };
        $view.innerHTML = '';
        const page = el('<div class="page"></div>');
        page.appendChild(el(`<div class="section-h"><h2>Results</h2><span class="meta">${items.length} match${items.length === 1 ? '' : 'es'} · “${esc(query)}”</span></div>`));
        if (!items.length) {
            page.appendChild(el(`<div class="empty"><div class="ico">${ICON.film}</div><h3>Nothing found</h3><p>No titles matched “${esc(query)}”. Check the spelling or try a shorter query.</p></div>`));
        } else {
            const grid = el('<div class="grid"></div>');
            items.forEach((it) => {
                const rate = it.rating ? `<span class="chip rate">★ ${Number(it.rating).toFixed(1)}</span>` : '';
                const card = el(`
                    <button class="poster" type="button">
                        <div class="art">
                            <span class="chip chip-amber kind">${it.type === 'tv' ? 'Series' : 'Film'}</span>
                            ${rate}${img(it.posterUrl, it.title)}
                        </div>
                        <div class="label"><div class="t">${esc(it.title)}</div><div class="y">${esc(it.year || '—')}</div></div>
                    </button>`);
                card.addEventListener('click', () => goWatch(it.id, it.type));
                grid.appendChild(card);
            });
            page.appendChild(grid);
        }
        $view.appendChild(page);
    }

    // ── watch ─────────────────────────────────────────────────────────────────
    let player = null;
    function destroyPlayer() { if (player) { try { player.destroy(); } catch (e) {} player = null; } }

    function goWatch(id, type) { location.hash = `#/${type}/${id}`; }

    async function openWatch(id, type) {
        destroyPlayer();
        $view.innerHTML = `<div class="page"><div class="loading"><span class="spinner"></span> Loading title…</div></div>`;
        try {
            const info = await api(`/info?id=${id}&type=${type}`);
            renderWatch(info);
        } catch (e) { toast('Couldn’t load that title — ' + e.message, 'bad'); renderHero(); }
    }

    function renderWatch(info) {
        const isTv = info.type === 'tv';
        const facts = [];
        if (info.year) facts.push(`<span>${esc(info.year)}</span>`);
        facts.push(`<span>${isTv ? 'Series' : 'Film'}</span>`);
        if (info.rating) facts.push(`<span style="color:var(--amber-strong)">★ ${Number(info.rating).toFixed(1)}</span>`);
        if (info.imdbId) facts.push(`<span>${esc(info.imdbId)}</span>`);
        const factsHtml = facts.join('<span class="dot"></span>');
        const genres = (info.genres || []).slice(0, 5).map((g) => `<span class="chip">${esc(g)}</span>`).join('');

        $view.innerHTML = '';
        if (info.backgroundUrl) $view.appendChild(el(`<div class="backdrop"><img src="${esc(info.backgroundUrl)}" alt=""></div>`));
        const page = el(`
            <div class="page">
                <a class="back-link" href="#" id="backLink">${ICON.back} Back</a>
                <div class="watch">
                    <div class="main">
                        <div id="stage"></div>
                        <div class="title-block">
                            <div class="kicker"><span class="eyebrow">Now showing</span></div>
                            <h1>${esc(info.title)}</h1>
                            <div class="facts">${factsHtml}</div>
                            ${info.description ? `<p class="overview">${esc(info.description)}</p>` : ''}
                            ${genres ? `<div class="genres">${genres}</div>` : ''}
                        </div>
                        <div id="episodes"></div>
                    </div>
                    <aside class="rail">
                        <div class="manifest">
                            <div class="head"><h3>Sources</h3><span class="count" id="srcCount">—</span></div>
                            <div id="srcArea"></div>
                            <div id="subsArea"></div>
                        </div>
                    </aside>
                </div>
            </div>`);
        $view.appendChild(page);
        window.scrollTo(0, 0);
        page.querySelector('#backLink').addEventListener('click', (e) => { e.preventDefault(); goBack(); });

        player = window.SP.createPlayer(page.querySelector('#stage'));

        if (isTv) renderEpisodes(info);
        else loadStreams(info, null, null);
    }

    function renderEpisodes(info) {
        const area = document.getElementById('episodes');
        const seasons = (info.seasons || []).filter((s) => s.seasonNumber > 0);
        if (!seasons.length) { loadStreams(info, 1, 1); return; }
        const opts = seasons.map((s) => `<option value="${s.seasonNumber}">${esc(s.name || 'Season ' + s.seasonNumber)}</option>`).join('');
        area.innerHTML = '';
        area.appendChild(el(`
            <div class="episodes">
                <div class="row"><span class="eyebrow">Episodes</span><select class="select" id="seasonSel" aria-label="Season">${opts}</select></div>
                <div class="ep-grid" id="epGrid"></div>
            </div>`));
        const sel = document.getElementById('seasonSel');
        const build = () => {
            const s = seasons.find((x) => String(x.seasonNumber) === sel.value);
            const n = Math.max((s && s.episodeCount) || 0, 1);
            const grid = document.getElementById('epGrid');
            grid.innerHTML = '';
            for (let i = 1; i <= n; i++) {
                const b = el(`<button class="ep" type="button">${i}</button>`);
                b.addEventListener('click', () => { grid.querySelectorAll('.ep').forEach((x) => x.classList.remove('active')); b.classList.add('active'); loadStreams(info, +sel.value, i); });
                grid.appendChild(b);
            }
        };
        sel.addEventListener('change', build);
        build();
    }

    // ── source parsing / grouping ─────────────────────────────────────────────
    const qualityNum = (s) => {
        const t = `${s.quality || ''} ${s.server || ''}`;
        if (/\b(2160|4k|uhd)\b/i.test(t)) return 2160;
        if (/\b1440\b/.test(t)) return 1440;
        if (/\b1080\b/.test(t)) return 1080;
        if (/\b720\b/.test(t)) return 720;
        if (/\b480\b/.test(t)) return 480;
        const m = /(\d{3,4})\s*p/i.exec(t); return m ? parseInt(m[1]) : 0;
    };
    const typeRank = (t) => (t === 'm3u8' ? 0 : t === 'mp4' ? 1 : 2);
    const bucketOf = (q) => (q >= 2160 ? '4K' : q >= 1080 ? '1080p' : q >= 720 ? '720p' : 'SD');
    const LANGS = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Punjabi', 'Marathi', 'Spanish', 'French', 'German', 'Korean', 'Japanese', 'Chinese', 'Arabic', 'Russian', 'Italian', 'Portuguese'];
    function detectAudio(name) {
        const n = name || '';
        if (/\bdual\b/i.test(n)) return 'Dual';
        if (/\bmulti(-?audio)?\b/i.test(n)) return 'Multi';
        return LANGS.find((l) => new RegExp('\\b' + l + '\\b', 'i').test(n)) || '';
    }
    function parseSource(s, idx) {
        const server = s.server || 'Source';
        const provider = (server.match(/^[^\s\[\](\-]+/) || [server])[0];
        let variant = server.slice(provider.length).replace(/^[\s\-[(]+/, '').replace(/[\])]+$/, '').trim();
        const q = qualityNum(s);
        if (!variant) variant = (s.type || '').toUpperCase();
        return { ...s, idx, provider, variant, q, qLabel: s.quality || (q ? q + 'p' : ''), bucket: bucketOf(q), audio: detectAudio(server), fmt: (s.type || '').toUpperCase() };
    }
    const prettyProvider = (p) => p; // provider tokens are already brand names (VidFast, HexaSU…)

    async function loadStreams(info, season, episode) {
        const area = document.getElementById('srcArea');
        const subsArea = document.getElementById('subsArea');
        const count = document.getElementById('srcCount');
        subsArea.innerHTML = '';
        count.textContent = '';
        area.innerHTML = `<div class="loading"><span class="spinner"></span> Scanning providers… ~20s</div>`;
        let q = `/streams?id=${info.id}&type=${info.type}`;
        if (season != null) q += `&season=${season}&episode=${episode}`;
        try {
            const data = await api(q);
            renderSources(info, data, season, episode);
        } catch (e) {
            area.innerHTML = `<div class="empty"><div class="ico">${ICON.film}</div><h3>Couldn’t scan</h3><p>${esc(e.message)}</p></div>`;
        }
    }

    const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

    function renderSources(info, data, season, episode) {
        const area = document.getElementById('srcArea');
        const subsArea = document.getElementById('subsArea');
        const count = document.getElementById('srcCount');
        subsArea.innerHTML = '';
        area.innerHTML = '';

        // flat, quality-sorted list (index space the player uses), then grouped by provider
        const streams = (data.streams || []).map((s, i) => parseSource(s, i))
            .sort((a, b) => typeRank(a.type) - typeRank(b.type) || b.q - a.q);
        streams.forEach((s, i) => (s.idx = i)); // reindex after sort
        const subs = data.subtitles || [];
        count.textContent = `${streams.length} found`;

        if (!streams.length) {
            area.appendChild(el(`<div class="empty"><div class="ico">${ICON.film}</div><h3>No sources</h3><p>Providers returned nothing for this${season != null ? ' episode' : ' title'}. Try another episode or check back later.</p></div>`));
            return;
        }

        // group by provider
        const groups = [];
        const byName = new Map();
        streams.forEach((s) => {
            let g = byName.get(s.provider);
            if (!g) { g = { provider: s.provider, items: [], best: 0 }; byName.set(s.provider, g); groups.push(g); }
            g.items.push(s); g.best = Math.max(g.best, s.q);
        });
        groups.sort((a, b) => b.best - a.best || b.items.length - a.items.length);

        // filter options actually present
        const bucketsPresent = ['4K', '1080p', '720p', 'SD'].filter((b) => streams.some((s) => s.bucket === b));
        const audiosPresent = [...new Set(streams.map((s) => s.audio).filter(Boolean))];
        const active = { q: new Set(), a: new Set() };

        const filterBar = el('<div class="src-filters"></div>');
        const mkChip = (label, kind, val, n) => {
            const c = el(`<button class="fchip" type="button">${esc(label)}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`);
            c.addEventListener('click', () => { const set = active[kind]; set.has(val) ? set.delete(val) : set.add(val); c.classList.toggle('on'); paint(); });
            return c;
        };
        bucketsPresent.forEach((b) => filterBar.appendChild(mkChip(b, 'q', b, streams.filter((s) => s.bucket === b).length)));
        audiosPresent.forEach((a) => filterBar.appendChild(mkChip(a, 'a', a, streams.filter((s) => s.audio === a).length)));
        if (bucketsPresent.length > 1 || audiosPresent.length) area.appendChild(filterBar);

        const groupsWrap = el('<div></div>');
        area.appendChild(groupsWrap);

        const ctx = { streams, subs, area, poster: info.backgroundUrl || info.posterUrl };

        function pass(s) {
            return (!active.q.size || active.q.has(s.bucket)) && (!active.a.size || active.a.has(s.audio));
        }
        function paint() {
            groupsWrap.innerHTML = '';
            let shown = 0;
            groups.forEach((g, gi) => {
                const items = g.items.filter(pass);
                if (!items.length) return;
                shown += items.length;
                // collapse all by default; markPlaying() opens the active source's group
                const grp = el(`<div class="src-group" data-provider="${esc(g.provider)}"></div>`);
                const head = el(`
                    <button class="group-head" type="button">
                        ${CHEV}
                        <span class="pname">${esc(prettyProvider(g.provider))}</span>
                        <span class="pcount">${items.length}</span>
                        <span class="pbest ${g.best >= 720 ? '' : 'sd'}">${esc(bucketOf(g.best))}</span>
                    </button>`);
                head.addEventListener('click', () => grp.classList.toggle('open'));
                grp.appendChild(head);
                const body = el('<div class="group-body"></div>');
                items.forEach((s) => {
                    const tags = [
                        s.qLabel ? `<span class="tag ${s.q >= 720 ? 'hd' : ''}">${esc(s.qLabel)}</span>` : '',
                        s.audio ? `<span class="tag audio">${esc(s.audio)}</span>` : '',
                        `<span class="tag fmt">${esc(s.fmt)}</span>`,
                    ].join('');
                    const row = el(`<button class="srow" type="button" data-i="${s.idx}"><span class="led"></span><span class="sname">${esc(s.variant)}</span><span class="tags">${tags}</span></button>`);
                    row.addEventListener('click', () => selectSource(ctx, s.idx));
                    body.appendChild(row);
                });
                grp.appendChild(body);
                groupsWrap.appendChild(grp);
            });
            count.textContent = `${shown} of ${streams.length}`;
            // restore playing highlight
            if (ctx.current != null) markPlaying(ctx, ctx.current);
        }
        paint();

        if (subs.length) {
            subsArea.appendChild(el(`<div class="subs"><h3>Subtitles <span class="faint mono" style="font-size:var(--t-xs)">${subs.length}</span></h3></div>`));
            const sl = el('<div class="subs-list"></div>');
            subs.slice(0, 50).forEach((sub) => sl.appendChild(el(`<a class="chip" href="${esc(sub.url)}" target="_blank" rel="noopener" title="${esc(sub.url)}">${ICON.cc} ${esc(sub.language || 'Sub')}</a>`)));
            subsArea.querySelector('.subs').appendChild(sl);
        }

        // auto-start the first playable source (respecting the Autoplay setting)
        const first = streams.findIndex((s) => s.type === 'm3u8' || s.type === 'mp4');
        if (settings.autoplay) selectSource(ctx, first >= 0 ? first : 0);
    }

    function markPlaying(ctx, i) {
        ctx.area.querySelectorAll('.srow.playing').forEach((r) => r.classList.remove('playing'));
        ctx.area.querySelectorAll('.src-group.has-playing').forEach((g) => g.classList.remove('has-playing'));
        const row = ctx.area.querySelector(`.srow[data-i="${i}"]`);
        if (row) { row.classList.add('playing'); const grp = row.closest('.src-group'); if (grp) { grp.classList.add('has-playing', 'open'); } }
    }

    function selectSource(ctx, i) {
        ctx.current = i;
        markPlaying(ctx, i);
        player.load(ctx.streams[i], { subtitles: ctx.subs || [], poster: ctx.poster });
    }

    function goBack() {
        destroyPlayer();
        if (location.hash) location.hash = '';
        if (lastResults && $search.value.trim()) renderResults(lastResults.query, lastResults.items);
        else renderHero();
    }

    // ── search wiring ─────────────────────────────────────────────────────────
    const doSearch = async (q) => {
        if (!q) { if (!location.hash) renderHero(); return; }
        renderSkeletons();
        try { const items = await api('/search?q=' + encodeURIComponent(q)); if ($search.value.trim() === q) renderResults(q, items); }
        catch (e) { toast('Search failed — ' + e.message, 'bad'); }
    };
    const runSearch = (q) => { if (location.hash) location.hash = ''; doSearch(q); };
    const liveSearch = debounce((q) => { if (q.length >= 2) runSearch(q); else if (!q) renderHero(); }, 380);

    $search.addEventListener('input', (e) => liveSearch(e.target.value.trim()));
    $search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $search.value = ''; renderHero(); } });
    document.getElementById('brandLink').addEventListener('click', (e) => { e.preventDefault(); $search.value = ''; location.hash = ''; renderHero(); });

    // ── routing ───────────────────────────────────────────────────────────────
    function route() {
        const m = location.hash.match(/^#\/(movie|tv)\/(\d+)/);
        if (m) openWatch(Number(m[2]), m[1]);
        else if ($search.value.trim()) doSearch($search.value.trim());
        else renderHero();
    }
    window.addEventListener('hashchange', route);
    route();
})();
