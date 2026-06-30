/* StreamPlay — custom video player. Exposes window.SP.createPlayer + proxy helpers. */
(function () {
    'use strict';

    // ── proxy helpers ─────────────────────────────────────────────────────────
    function b64url(s) {
        return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function proxyUrl(link, headers, isM3u8) {
        const u = b64url(link);
        const h = headers ? '&h=' + b64url(JSON.stringify(headers)) : '';
        return '/api/proxy?url=' + u + h + (isM3u8 ? '&m3u8=1' : '');
    }
    function subProxyUrl(url) { return '/api/proxy/sub?url=' + b64url(url); }

    const I = {
        play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
        volHigh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
        volMute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
        cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8.5 10a2 2 0 1 0 0 4"/><path d="M15.5 10a2 2 0 1 0 0 4"/></svg>',
        speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M2 12h2"/><path d="M12 6v0"/><path d="M12 12l4-2.5"/></svg>',
        pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>',
        fsOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        fsOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    };

    const fmt = (s) => {
        if (!isFinite(s) || s < 0) s = 0;
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
        const mm = String(m).padStart(h ? 2 : 1, '0'), xx = String(x).padStart(2, '0');
        return h ? `${h}:${mm}:${xx}` : `${mm}:${xx}`;
    };

    function createPlayer(mount) {
        mount.innerHTML = `
            <div class="stage" tabindex="0">
                <div class="poster-fill hidden"><img alt=""></div>
                <video playsinline></video>
                <button class="center-play" aria-label="Play">${I.play}</button>
                <div class="buffering"></div>
                <div class="stage-error">${I.alert}<div class="msg"></div><div class="hint"></div></div>
                <div class="ctl">
                    <div class="scrub"><div class="track"><div class="buffered"></div><div class="played"></div><div class="knob"></div></div><div class="hover-time">0:00</div></div>
                    <div class="ctl-row">
                        <button class="ctl-btn big play" aria-label="Play/Pause">${I.play}</button>
                        <div class="vol">
                            <button class="ctl-btn mute" aria-label="Mute">${I.volHigh}</button>
                            <div class="vol-slider"><input type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume"></div>
                        </div>
                        <span class="ctl-time"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></span>
                        <span class="ctl-spacer"></span>
                        <div class="ctl-menu-wrap cc-wrap">
                            <button class="ctl-btn cc" aria-label="Captions">${I.cc}</button>
                            <div class="ctl-pop cc-pop"></div>
                        </div>
                        <div class="ctl-menu-wrap speed-wrap">
                            <button class="ctl-btn speedbtn" aria-label="Playback speed">${I.speed}</button>
                            <div class="ctl-pop speed-pop"></div>
                        </div>
                        <button class="ctl-btn pip" aria-label="Picture in picture">${I.pip}</button>
                        <button class="ctl-btn fs" aria-label="Fullscreen">${I.fsOff}</button>
                    </div>
                </div>
            </div>`;

        const stage = mount.querySelector('.stage');
        const video = mount.querySelector('video');
        const posterFill = mount.querySelector('.poster-fill');
        const posterImg = posterFill.querySelector('img');
        const errBox = mount.querySelector('.stage-error');
        const $ = (s) => stage.querySelector(s);
        const els = {
            centerPlay: $('.center-play'), playBtn: $('.play'), muteBtn: $('.mute'), vol: $('.vol input'),
            cur: $('.cur'), dur: $('.dur'), scrub: $('.scrub'), played: $('.played'), buffered: $('.buffered'),
            knob: $('.knob'), hoverTime: $('.hover-time'), cc: $('.cc'), ccPop: $('.cc-pop'),
            speedBtn: $('.speedbtn'), speedPop: $('.speed-pop'), pip: $('.pip'), fs: $('.fs'),
        };

        let hls = null, iframe = null, hideTimer = null;
        let state = { subtitles: [] };

        function destroyHls() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } }
        function removeIframe() { if (iframe) { iframe.remove(); iframe = null; } }

        function showError(msg, hint) {
            stage.classList.add('errored'); stage.classList.remove('buffering', 'playing');
            errBox.querySelector('.msg').textContent = msg;
            errBox.querySelector('.hint').textContent = hint || '';
        }

        function load(stream, opts) {
            opts = opts || {};
            destroyHls(); removeIframe();
            stage.classList.remove('errored', 'playing', 'buffering');
            // clear existing subtitle tracks
            [...video.querySelectorAll('track')].forEach((t) => t.remove());
            state.subtitles = opts.subtitles || [];
            renderCaptionsMenu();

            if (opts.poster) { posterImg.src = opts.poster; posterFill.classList.remove('hidden'); }
            else posterFill.classList.add('hidden');

            if (stream.type === 'iframe') {
                video.classList.add('hidden');
                iframe = document.createElement('iframe');
                iframe.src = stream.link;
                iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
                iframe.referrerPolicy = 'origin';
                iframe.allowFullscreen = true;
                stage.insertBefore(iframe, errBox);
                stage.classList.add('iframe-mode');
                return;
            }
            video.classList.remove('hidden');
            stage.classList.remove('iframe-mode');

            const isM3u8 = stream.type === 'm3u8' || /\.m3u8(\?|$)/i.test(stream.link);
            const src = proxyUrl(stream.link, stream.headers, isM3u8);
            stage.classList.add('buffering');

            if (isM3u8 && window.Hls && Hls.isSupported()) {
                hls = new Hls({ enableWorker: true, lowLatencyMode: false, fragLoadingMaxRetry: 2, manifestLoadingMaxRetry: 2 });
                hls.loadSource(src);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
                hls.on(Hls.Events.ERROR, (_e, d) => {
                    if (d && d.fatal) { destroyHls(); showError('This source failed to load.', 'Try another source from the list.'); }
                });
            } else {
                video.src = src;
                video.addEventListener('loadedmetadata', tryPlay, { once: true });
                video.addEventListener('error', () => showError('This source can’t be played.', 'Try another source from the list.'), { once: true });
            }
        }

        function tryPlay() {
            stage.classList.remove('buffering');
            video.play().catch(() => { /* needs gesture — center-play stays */ });
        }

        const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
        function buildSpeedMenu() {
            els.speedPop.innerHTML = '<div class="ph">Speed</div>' + SPEEDS.map((r) =>
                `<button data-r="${r}" class="${r === 1 ? 'active' : ''}">${r === 1 ? 'Normal' : r + '×'}</button>`).join('');
            els.speedPop.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
                video.playbackRate = +b.dataset.r;
                els.speedPop.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
                b.classList.add('active'); closeMenus();
            }));
        }
        function renderCaptionsMenu() {
            const p = els.ccPop;
            const subs = state.subtitles;
            els.cc.style.display = subs.length ? '' : 'none';
            if (!subs.length) { p.innerHTML = ''; return; }
            p.innerHTML = '<div class="ph">Subtitles</div>' +
                `<button data-i="-1" class="active">Off</button>` +
                subs.slice(0, 60).map((s, i) => `<button data-i="${i}">${escapeHtml(s.language || 'Track ' + (i + 1))}</button>`).join('');
            p.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
                p.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
                b.classList.add('active'); selectSubtitle(+b.dataset.i); closeMenus();
            }));
        }
        function selectSubtitle(i) {
            [...video.textTracks].forEach((t) => (t.mode = 'disabled'));
            [...video.querySelectorAll('track')].forEach((t) => t.remove());
            if (i < 0) return;
            const sub = state.subtitles[i]; if (!sub) return;
            const track = document.createElement('track');
            track.kind = 'subtitles'; track.label = sub.language || 'Subtitle'; track.srclang = 'en';
            track.src = subProxyUrl(sub.url); track.default = true;
            video.appendChild(track);
            track.addEventListener('load', () => { if (video.textTracks[0]) video.textTracks[0].mode = 'showing'; });
            setTimeout(() => { if (video.textTracks[0]) video.textTracks[0].mode = 'showing'; }, 300);
        }

        // ── transport ──────────────────────────────────────────────────────────
        const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
        els.centerPlay.addEventListener('click', togglePlay);
        els.playBtn.addEventListener('click', togglePlay);
        video.addEventListener('click', togglePlay);
        video.addEventListener('play', () => { stage.classList.add('playing'); els.playBtn.innerHTML = I.pause; posterFill.classList.add('hidden'); });
        video.addEventListener('pause', () => { stage.classList.remove('playing'); els.playBtn.innerHTML = I.play; });
        video.addEventListener('waiting', () => stage.classList.add('buffering'));
        video.addEventListener('playing', () => stage.classList.remove('buffering'));
        video.addEventListener('timeupdate', updateProgress);
        video.addEventListener('progress', updateBuffered);
        video.addEventListener('loadedmetadata', () => { els.dur.textContent = fmt(video.duration); });
        video.addEventListener('ended', () => stage.classList.remove('playing'));

        function updateProgress() {
            const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
            els.played.style.width = pct + '%'; els.knob.style.left = pct + '%';
            els.cur.textContent = fmt(video.currentTime);
        }
        function updateBuffered() {
            if (!video.duration || !video.buffered.length) return;
            els.buffered.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100 + '%';
        }

        // scrubbing
        function seekFromEvent(e) {
            const r = els.scrub.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            if (video.duration) video.currentTime = ratio * video.duration;
        }
        let scrubbing = false;
        els.scrub.addEventListener('pointerdown', (e) => { scrubbing = true; els.scrub.setPointerCapture(e.pointerId); seekFromEvent(e); });
        els.scrub.addEventListener('pointermove', (e) => {
            const r = els.scrub.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            els.hoverTime.style.left = ratio * 100 + '%';
            els.hoverTime.textContent = fmt(ratio * (video.duration || 0));
            if (scrubbing) seekFromEvent(e);
        });
        els.scrub.addEventListener('pointerup', () => { scrubbing = false; });

        // volume
        els.vol.addEventListener('input', () => { video.volume = +els.vol.value; video.muted = +els.vol.value === 0; updateVolIcon(); });
        els.muteBtn.addEventListener('click', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; updateVolIcon(); });
        function updateVolIcon() {
            const muted = video.muted || video.volume === 0;
            els.muteBtn.innerHTML = muted ? I.volMute : I.volHigh;
            els.vol.value = muted ? 0 : video.volume;
        }

        // menus
        function closeMenus() { els.ccPop.classList.remove('open'); els.speedPop.classList.remove('open'); }
        function toggleMenu(pop) { const open = pop.classList.contains('open'); closeMenus(); if (!open) pop.classList.add('open'); }
        els.cc.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.ccPop); });
        els.speedBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.speedPop); });
        document.addEventListener('click', closeMenus);
        stage.addEventListener('click', (e) => { if (!e.target.closest('.ctl-menu-wrap')) closeMenus(); });

        // pip + fullscreen
        els.pip.addEventListener('click', async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch (e) {} });
        els.fs.addEventListener('click', toggleFs);
        function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen().catch(() => {}); }
        document.addEventListener('fullscreenchange', () => {
            const on = document.fullscreenElement === stage;
            stage.classList.toggle('fs', on); els.fs.innerHTML = on ? I.fsOn : I.fsOff;
        });

        // auto-hide controls
        function showCtl() {
            stage.classList.add('show-ctl'); stage.classList.remove('hide-cursor');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { if (!video.paused) { stage.classList.remove('show-ctl'); stage.classList.add('hide-cursor'); closeMenus(); } }, 2600);
        }
        stage.addEventListener('mousemove', showCtl);
        stage.addEventListener('mouseleave', () => { if (!video.paused) { stage.classList.remove('show-ctl'); } });

        // keyboard
        stage.addEventListener('keydown', (e) => {
            const k = e.key.toLowerCase();
            if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' '].includes(e.key.toLowerCase()) || ['k', 'm', 'f', 'c'].includes(k)) e.preventDefault();
            if (e.key === ' ' || k === 'k') togglePlay();
            else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
            else if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 10);
            else if (e.key === 'ArrowUp') { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; updateVolIcon(); }
            else if (e.key === 'ArrowDown') { video.volume = Math.max(0, video.volume - 0.1); updateVolIcon(); }
            else if (k === 'm') { video.muted = !video.muted; updateVolIcon(); }
            else if (k === 'f') toggleFs();
            else if (k === 'c') { const b = els.ccPop.querySelector('button[data-i="0"]'); if (b) b.click(); }
            else if (k >= '0' && k <= '9' && video.duration) video.currentTime = (parseInt(k) / 10) * video.duration;
            showCtl();
        });

        function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
        function shortName(s) { return String(s || '').replace(/\s*[\[(].*$/, '').trim() || s; }

        function destroy() { destroyHls(); removeIframe(); try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {} clearTimeout(hideTimer); }

        updateVolIcon(); buildSpeedMenu();
        return { load, destroy, focus: () => stage.focus() };
    }

    window.SP = { createPlayer, proxyUrl, subProxyUrl };
})();
