# Anime provider research — English-dub focus

Goal: as many **English-dubbed** anime sources as possible, so if one provider
breaks the user can switch to another. This surveys the whole CloudStream extension
ecosystem (not just the popular repos), classifies every anime provider found, and
records a feasibility verdict for porting each to StreamPlay's `Provider` interface.

**Legend** — Feasibility: ✅ built · 🟢 portable (build-ready) · 🟡 hard (anti-bot / needs FlareSolverr / API rewrite) · 🔴 dead/infeasible.
Dub = has an English dub track/servers. "Plain" = no obfuscation; resolves to m3u8 over plain HTTP.

Last investigated: 2026-07 (domains rotate — re-verify before building).

## Repos surveyed
| Repo | Where | Notes |
|---|---|---|
| phisher98/cloudstream-extensions-phisher | GitHub (460★, active) | Biggest current English repo. Source is compiled-only (`builds` branch) — 42 anime plugins in `plugins.json`. |
| cloudstream/cloudstream-extensions-hexated | Codeberg (active) | Classic hexated set; full source. Kickassanime, YugenAnime, Wcofun, many regional. |
| HatsuneMikuUwU/cloudstream-extensions-uwu | GitHub (active) | Anime/donghua, **Indonesian** sub. |
| Blatzar/recloudstream | GitHub (official, older) | Mostly regional movie/TV; FMovies/Sflix family (megacloud). |
| CakesTwix (uk), ImZaw (arabic), Luna712, 821938089 | GitHub | Non-English / niche. |

## ✅ Built & active in StreamPlay (dub-capable first)
| Provider | Dub | Notes |
|---|---|---|
| **AnimeNoSub** (animenosub.to) | ✅ EN sub+dub | NEW. DooPlay → megaplay.buzz `getSources` → direct m3u8 + subs. `/sub↔/dub` swap. Plain HTTP. |
| **AniNeko** (anineko.to) | ✅ sub/hardsub/dub | Via FlareSolverr + packed embeds. |
| **AnimeWorld** (watchanimeworld.net) | ✅ Hindi/Tamil/Telugu + Eng/Jap | Indian dubs. |
| **CastleTV** (api.hlowb.com) | ✅ Hindi/Eng dubs | Also carries dubbed anime (medium-matched). |
| **AniZone** (anizone.to) | 🔸 multi-audio | Single HLS with JP/EN audio + many subs (dub via audio track). |

## 🟢 English-dub candidates — portable, build-ready (recommended next)
| Provider | Domain | Dub | Method | Verdict |
|---|---|---|---|---|
| **Wcofun / WCO** (WatchCartoonOnline) | wcofun.net | ✅ **dub-heavy** | `getvidlink.php` + base64/char-shift decode (plain) | 🟢 Best dub-catalog gain. May need FlareSolverr (CF on some mirrors). Cartoons + dubbed anime. |
| **KickAssAnime** | kaa.mx / kickassanime.mx | ✅ sub+dub | base64→`pb.kaast1.com/…/master.m3u8` + `/api/source/` JSON | 🟢 m3u8, no megacloud. Site API rewrites often → port against the CURRENT kaa.mx API, not the 2024 hexated code. |
| **AnimeDekho** (phisher98) | — | ✅ OnePace DUB/SUB + Hindi | phisher source is compiled-only; RE from live site | 🟢 Indian multi + dub. |

## 🟡 Reachable but harder (anti-bot / captcha / needs work)
| Provider | Domain | Dub | Blocker |
|---|---|---|---|
| **YugenAnime** | yugenanime.ro/.tv | ✅ sub+dub | JS **fingerprint** anti-bot (`/js/fingerprint/iife.min.js`) — needs headless/FlareSolverr; `/api/embed/` otherwise clean. |
| **AllAnime / Anichi** | allanime.to | ✅ native sub+dub | Already in tree (disabled): `NEED_CAPTCHA` on our IP + WARP egress. Revive from residential IP. |
| **AnimePahe** | animepahe.* | ✅ SUB/DUB | Already in tree (disabled): kwik.cx CDN 403s our egresses (incl. FlareSolverr). |
| **AnimeOwl** | animeowl.me | ✅ sub+dub | Returns a JS-challenge shell (473 B) — headless needed. |
| **AnimeOnsen** | animeonsen.xyz | ✅ **dub-focused** | 301/redirect; small catalog, API auth. Worth a look for dub-only. |

## 🔴 Dead / infeasible (do not build)
| Provider | Why |
|---|---|
| HiAnime / Zoro / aniwatch, HDToday, Sflix, Dopebox, Fmovies | Operation 404 (2026) + megacloud/rabbitstream AES key dance (dead). |
| **AnimeKai** (animekai.to) | Cloudflare + megacloud-family (unreachable/obfuscated). |
| **9anime / aniwave / AnimeSuge** | RC4 `vrf` anti-bot (same class as anikoto — infeasible). |
| AnimeHeaven (animeheaven.me), Hikari (hikari.gg) | Unreachable (dead domains). |
| Animixplay | Long dead. |

## Regional (non-English) — skipped for the dub goal
Kept for completeness; useful only for those languages.
- **Indonesian (sub):** Otakudesu, Samehadaku, Kuronime, Kuramanime, Gomunime, Oploverz, Neonime, NontonAnimeID, AnimeSail, AnimeIndo, Anoboy, Nimegami, Winbu, Anichin (donghua), Animexin (donghua).
- **Spanish / LatAm:** Latanime, Animeav1, DoramasYT.
- **German:** AnimeCloud, Aniworld (Serienstream), Megakino.
- **Chinese (donghua):** Animekhor, Donghuastream, Bilibili.
- **Other:** Anilibria (ru), Anizm (tr), Cinefreak (bn), Tocanime, Anifreakz.

## Hindi / multi-language dub (carry English dub for some titles)
From phisher98 (compiled-only — would RE from the live sites):
AnimeDekho, Animedubhindi, Animesalt, Piratexplay, RingZ, DoraBash (Doraemon),
ToonHub (toonhub4u), Toonstream, ToonTales, Topcartoons. StreamPlay already has the
overlapping movie/multi ones (AllMovieLand, MultiMovies, HDhub4u).

## Recommendation (priority order for the next builds)
1. **Wcofun / WCO** — biggest English-**dub** catalog gain (dubbed anime + cartoons), plain decode. Verify Cloudflare first (use FlareSolverr if needed).
2. **KickAssAnime** — large sub+dub, clean m3u8, but port against the *current* kaa.mx API.
3. **AnimeDekho** — Indian + English dub (OnePace etc.).
4. Revisit **AllAnime** and **AnimePahe** from a residential IP / self-hosted Consumet — both are natively sub+dub and already coded.

Non-goals: anything on megacloud/vrf (dead), and non-English regional sites.
