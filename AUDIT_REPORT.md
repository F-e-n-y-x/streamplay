# AUDIT_REPORT.md — StreamPlay (Phase 1)

**Date:** 2026-07-05 · **Scope:** full read + run audit, no code changed.
**Method:** verified by running, not just reading — `npm run build`, `tsc` (server + client),
a headless-Chromium (Playwright) pass over 13 routes capturing console/network errors, and
responsive screenshots at **360 / 390 / 768 / 1024 / 1280 px**. Only verified issues are listed;
speculative problems were dropped (see "Investigated and dismissed").

## Headline

**This is a high-quality codebase, not a typical AI-slop app.** Both type-checks and the full
production build pass with zero errors. In the browser pass, **every one of the 13 routes produced
zero console errors/warnings, zero failed network requests, and zero API 4xx/5xx**, and **no page
had horizontal overflow at any of the five widths**. The Watch page resolves real streaming sources
live over SSE (2Embed, Vidrock, RiveStream, DahmerMovies, Xpass… with working 4K/1080p/multi-audio
filters), loading/empty/error states exist on the data screens, and the SSRF guard on the proxy is
genuinely robust. There are **no Critical or High issues.** Findings are Medium and below.

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 7 |

---

## MEDIUM

### M1 — No catch-all route: unknown URLs render a blank page
- **Where:** `client/src/App.tsx:27-40` (no `<Route path="*">`).
- **What:** React Router has no fallback route. Any unmatched client path (e.g. `/foo`, an old
  bookmarked link, a typo) renders **only the header with a completely empty body** — no "not found",
  no redirect home. Verified: screenshot of `/this/does/not/exist` shows header + blank content.
- **Why it matters:** Dead-end UX with no way back except the logo; looks broken. The Express SPA
  fallback (`src/index.ts:40`) correctly serves `index.html` for these, so the gap is purely client-side.
- **Proposed fix:** Add a `NotFound` element and `<Route path="*" element={<NotFound />} />` (a simple
  `.empty` card with a "Back to home" link, using existing primitives).

### M2 — `.note` uses `display:flex`, so notes with inline `<b>` fragment into cramped columns on mobile/tablet
- **Where:** `client/src/styles/app.css:527` (`.note { display:flex; ... }`); triggered by
  `client/src/pages/Providers.tsx:55` (WARP legend), `:140-143` ("Health is determined by…" hint),
  and `:130-135` (Torrent-mode note) — every `.note` whose content mixes text with `<b>` emphasis.
- **What:** With `display:flex` and no `flex-wrap`, each anonymous text run and each `<b>` becomes a
  separate non-wrapping flex item. On narrow viewports they get crushed, so the sentence breaks into
  several tall, 1–2-word columns. Verified visibly at **both 360px and 768px** (screenshots): the WARP
  legend and the Health hint render as disjoint narrow columns with awkward gaps.
- **Why it matters:** The explanatory copy on the Providers page is nearly unreadable on phone and
  tablet — the widths most likely used to check "is my FlareSolverr/WARP working?".
- **Proposed fix:** Make `.note` a normal block (`display:block`) for text, and add an explicit
  `.note-row`/icon modifier where a leading icon+text flex layout is actually wanted. (Or, minimal:
  `.note { flex-wrap: wrap }` — but block is the correct fix since the content is prose.)

### M3 — Unauthenticated, unbounded sync rooms (safe for personal use, risky if exposed)
- **Where:** `src/routes/sync.ts` — all `/api/sync/:code/*` endpoints; `:232` (`/bulk`) accepts and
  persists arbitrary JSON with no size/schema validation.
- **What:** A "sync code" is the only credential. Anyone who knows or guesses a code can **read and
  write** that room's history/favourites and bridge it into others; `check` also discloses claimed
  status + device count (enumeration). `/bulk` stores whatever JSON is posted to `sync-data.json`
  with no per-room size cap (room *count* is capped at 5000, but a single room's payload is not).
- **Why it matters:** By design for a firewalled personal instance this is fine. **On a publicly
  reachable instance it is an open, unauthenticated data store** and a disk-fill vector.
- **Proposed fix (report-only; needs your call):** Document clearly that the instance must not be
  exposed to the internet without an auth layer; optionally gate writes behind the existing
  `ADMIN_TOKEN`, cap per-room entry count/size, and rate-limit `/check`. *(Behavior change — will
  confirm with you before touching in Phase 2.)*

### M4 — `/api/proxy` is an unauthenticated open forward-proxy + wildcard CORS
- **Where:** `src/routes/proxy.ts:135` (`GET /`), `src/index.ts:15` (`app.use(cors())` = `*`).
- **What:** `/api/proxy?url=<any http/https>` will fetch and stream **any external URL** with no auth.
  It is correctly **SSRF-guarded against internal/private/loopback targets** (see `utils/ssrf.ts`), so
  it can't reach the LAN — but it will happily proxy arbitrary *public* content, and CORS `*` lets any
  origin read the responses.
- **Why it matters:** Necessary for playback (that's its job), and harmless on a personal LAN box. On a
  public instance it's an open proxy others can borrow for bandwidth/anonymization.
- **Proposed fix (report-only):** Same as M3 — document "don't expose publicly unauthenticated". No
  code change proposed unless you want a same-origin/referer check or token gate.

---

## LOW

### L1 — Two HLS engines shipped on the Watch route (~370 kB gzip combined)
- **Where:** `client/src/components/Player.tsx:2` (`import Hls from "hls.js"`, static) + `:401`
  (`import("shaka-player/...compiled.js")`, dynamic). Build output: `shaka-player.compiled` 652 kB
  (209 kB gz) **and** the `Player` chunk 533 kB (165 kB gz, includes hls.js).
- **What/why:** Both a Shaka path and an hls.js path are bundled as a fallback chain. Correctly
  code-split (only loads on `/watch`), so it doesn't bloat first paint — but it's a lot of JS for the
  player, and the two libraries overlap heavily in capability.
- **Proposed fix:** Confirm whether both are actually needed at runtime; if hls.js (or native HLS on
  Safari) covers the real source set, dropping Shaka removes ~209 kB gz. Investigate before removing.

### L2 — Dead "auto-muted" UI path in the player
- **Where:** `client/src/components/Player.tsx:180` (`useState(false)`), `:675` (`{autoMuted && …}` pill),
  `:487` (`unmute()`). `setAutoMuted(true)` is **never called** anywhere.
- **What/why:** `autoMuted` is permanently `false`, so the "Muted — click to unmute" pill can never
  render and `unmute()` is unreachable. Leftover from a removed muted-autoplay fallback.
- **Proposed fix:** Delete the `autoMuted` state, the pill block, and `unmute()` (use `simplify` on the touched region).

### L3 — Header "Live/Fallback" pill fetched once, never refreshed
- **Where:** `client/src/components/Header.tsx:29` — `useEffect(() => { api.health()… }, [])`.
- **What/why:** Health is read only on mount, with no interval. If TMDB later drops to fallback (or
  recovers), the pill stays stale for the life of the tab.
- **Proposed fix:** Poll on an interval (e.g. every 60 s) or refetch via React Query with a `refetchInterval`.

### L4 — `api.post()` doesn't check `res.ok` (unlike `api.get()`)
- **Where:** `client/src/lib/api.ts:23-30`.
- **What/why:** `post()` calls `res.json()` unconditionally; a non-2xx that returns non-JSON would throw
  a parse error rather than a clean `API <status>` error. Currently **mitigated** — the only caller,
  `TorznabCard.save()` (`Settings.tsx:57-61`), wraps it in `try/catch` and the server always returns
  `{ok,error}` JSON. Flagged as fragility, not a live bug.
- **Proposed fix:** Mirror `get()`'s `if (!res.ok) throw` (and tolerate empty bodies).

### L5 — Hardcoded provider keys/fingerprints committed in plaintext (server-side only)
- **Where:** `src/extractors/vidrock.ts:10`, `peachify.ts:23`, `vidzee.ts:10-11`, `moviebox.ts:12-13,74,311`,
  `mapple.ts:100`, `castle.ts:169`, `allanime.ts:36,40`.
- **What/why:** AES/HMAC keys and a device fingerprint, embedded in source. These are
  **reverse-engineered provider constants ported from the CloudStream plugin — not user credentials**,
  and they are **not shipped in the client bundle** (verified: server-side extractors only). TMDB/TVDB
  keys are correctly env-only. So this is informational, not a secret leak.
- **Proposed fix:** None required for correctness. Optionally move to env for rotation. **Do not**
  treat as a credential-exposure incident.

### L6 — SSRF guard not re-applied on the WARP-fallback fetch branch
- **Where:** `src/routes/proxy.ts:17-25` (`fetchUpstream`) — the WARP retry uses `proxyWarpAgent()`
  without `ssrfAgents()`.
- **What/why:** The primary fetch is IP-guarded and `guardUrl` runs up front, and WARP egresses via
  Cloudflare (can't reach the LAN with remote DNS), so this is largely mitigated. But a redirect/rebind
  on the *fallback* branch isn't re-validated by the guarded DNS lookup.
- **Proposed fix:** Also attach the guarded agents (or a WARP-guarded lookup) on the fallback path for defense-in-depth.

### L7 — Tooling gaps: no tests, no ESLint, no Prettier
- **Where:** repo root + `client/` — no `eslint`/`prettier` config, no test files; `npm test` is a
  placeholder that exits 1 (`package.json:12`).
- **What/why:** Nothing enforces lint rules or catches regressions; the audit's "run lint / run tests"
  steps had nothing to run. Type-checking is the only automated gate (and it passes).
- **Proposed fix:** Add a minimal ESLint config (`@typescript-eslint` + `react-hooks`) and a smoke test
  or two (e.g. the SSRF guard, the HLS manifest rewriter — both pure and high-value). Suggestion, not a bug.

*(Also noted, informational: the legacy `/api/streams` route in `src/routes/index.ts:69` fans out to
**all** providers with no per-kind filter and no abort signal — superseded by the SSE resolver in
`web.ts`; heavy if ever hit, but the client no longer calls it.)*

---

## Investigated and dismissed (verified NOT issues — so you know they were checked, not skipped)

- **XSS:** no `dangerouslySetInnerHTML` / `innerHTML` / `eval` anywhere in `client/src`; React auto-escaping. Clean.
- **Secrets in client bundle:** none. TMDB/TVDB keys are read from env server-side; the browser only
  talks to `/api`. `.env`, `sync-data.json`, `*.log` are properly gitignored and not committed.
- **`kisskh.ts:72,76` empty `catch(e){}`:** initially flagged as "silent swallow" — on reading the
  surrounding code (`:78-81`) these are **intentional and documented** (the video key gates the
  provider; the subtitle key is optional). Not a defect. Dropped.
- **Horizontal overflow / broken layouts:** programmatic `scrollWidth > clientWidth` check across all
  5 widths × 9 pages found **none**; visual review of Home/Browse/Title/Watch/Providers/Settings at
  360 & 768 confirms clean stacking and correct reading order (Watch: player → sources → details).
- **Runtime errors:** zero console errors/warnings, zero failed requests, zero API 4xx/5xx over 13 routes.
- **Loading/empty/error states:** present — route Suspense fallback, per-page skeletons, `.empty`
  states, `ErrorBoundary` (resets on route change), and provider "Retry N unavailable" / "no source" states.
- **Build/typecheck:** server `tsc --noEmit` ✅, client `tsc -b` ✅, `npm run build` ✅ (only the expected
  Vite ">500 kB chunk" note for the code-split player — see L1).

---

## Screenshots
Saved under the session scratchpad `shots/` (desktop `desk-*.png`; responsive `w{360,390,768,1024,1280}-*.png`).

---

## Recommended Phase-2 order (pending your approval)
Since there are no Critical/High items, I suggest this order — **all low-risk, behavior-preserving**:
1. **M1** (404 route) and **M2** (`.note` mobile fix) — real user-facing UX bugs, self-contained CSS/JSX.
2. **L2** (delete dead mute code), **L3** (refresh health pill), **L4** (`post` ok check), **L6** (SSRF fallback hardening) — small, safe.
3. **M3/M4** are **documentation/behavior decisions** — I will **not** change API behavior without your explicit go-ahead; tell me if you want the deployment note, the `ADMIN_TOKEN` gate, or nothing.
4. **L1** (drop Shaka) and **L5/L7** (keys→env, add lint/tests) are **suggestions** I'd rather confirm scope on first.

**Stopping here for your approval before modifying any code (per the Phase-2 gate).**
Reply with which items to fix (e.g. "do M1, M2, L2–L4, L6") and I'll proceed one issue at a time,
re-running build + type-check and committing after each.
