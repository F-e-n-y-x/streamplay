# Anime Providers — Research & Build Plan

> Compiled from the CloudStream extensions wiki (https://cloudstream.miraheze.org/wiki/List_of_extensions),
> the major community repos, and **live probing on 2026-07-06**. Ratings are honest:
> "Catalog" = how much anime it has; "Maint." = how often it breaks; "Difficulty" =
> effort to port + keep working in StreamPlay's in-process scraper model.

## TL;DR

Every large free anime source (HiAnime, AnimeKai, AnimePahe, anikoto…) sits behind
**rotating anti-bot + encrypted embeds** (Cloudflare challenges, MegaCloud/MegaUp AES
that rotates keys, VRF tokens). In-process scrapers for them are a constant cat-and-mouse.
The **highest-ROI move is a self-hosted aggregator** you run like FlareSolverr/WARP —
**Consumet** (already supported here via `CONSUMET_URL`) or **aniwatch-api** — which the
community keeps patched and which unlocks Zoro/HiAnime/AnimeKai/Gogo/Pahe behind one env var.

## StreamPlay's current anime providers (live-audited 2026-07-06)

| Provider | Live result | Verdict |
|---|---|---|
| **AniZone** | ✅ 1 stream + ~15 subs every title | works — primary source |
| **AnimeWorld** (watchanimeworld) | ✅ returns m3u8 (zephyrflick) | works, a bit slow |
| **AllAnime** | ❌ NEED_CAPTCHA on server IP **and** WARP IPs | IP-reputation dead; needs clean residential IP |
| **AnimePahe** | ❌ Kwik host `kwik.cx` = Cloudflare 403 on every egress | needs FlareSolverr solve for Kwik |
| **Consumet** | ❌ 0 (returns instantly) | just unconfigured — set `CONSUMET_URL` |

## CloudStream anime providers — ranked

Catalog / Maint. / Difficulty are Low→High. "Repo" = a CloudStream source to port from.

| Provider | Catalog | Sub/Dub | Maint. | Difficulty | Embed / gate | Repo (reference) | Notes |
|---|---|---|---|---|---|---|---|
| **HiAnime** (hianime, ex-Zoro/AniWatch) | Very High | Both | High | Hard | MegaCloud (AES, rotates) | aniwatch (MIT npm), phisher98 | Biggest catalog. `aniwatch` npm handles MegaCloud but was **broken on 2026-07-06** (domain rotation) — proves the maintenance cost. |
| **AnimeKai** (animekai.to/.bz) | Very High | Both + soft-sub | High | Very Hard | MegaUp + custom enc/dec | phisher98, Kraptor | Huge, but the hardest active cat-and-mouse (token + AES rotate frequently). |
| **AllAnime** | High | Both | Med | Medium (but IP-gated) | native + clock.json | doGior, recloudstream | Already ported here; blocked by captcha on this box's IPs. |
| **AnimePahe** | High | Both | Med | Medium (blocked) | Kwik (Cloudflare) | recloudstream | Already ported; Kwik.cx now CF-403 — needs FlareSolverr. |
| **AnimeParadise** (animeparadise.moe) | Med-High | Sub | Low | **Easy** | direct JSON API | community | **Best portability**: clean JSON API, little obfuscation. Top pick for a new build. |
| **Miruro** (miruro.tv) | High | Both | Med | Medium | API aggregator | community | Front-end over AllAnime/others; API-based. |
| **AnimeOwl** | Med | Both | Med | Medium | custom embed | phisher98 | Decent fallback. |
| **AniZone** (anizone.to) | Med | Sub | Low | Easy | direct | already here | Already the working primary. |
| **AnimeWorld** (watchanimeworld) | Med | Both (dub-heavy) | Med | Medium | zephyrflick | already here | Already works. |
| **Gogoanime / Anitaku** | — | — | — | — | — | — | Effectively dead / endlessly moved — skip. |
| **anikototv.to** | High | Both | High | Hard | VRF token + MegaCloud | (site only) | Two rotating anti-bot layers; not worth a bespoke scraper — same catalog as HiAnime. |

## Recommended 3 to build (feasibility-weighted)

1. **AnimeParadise** — clean JSON API, biggest bang-for-effort, **verifiable**. Build first.
2. **HiAnime** — biggest catalog; reuse the MIT `aniwatch` MegaCloud decryptor, pointed at the current domain. High value but expect upkeep.
3. **AnimeKai** *or* self-hosted **Consumet** — AnimeKai is the largest gap but the hardest; **Consumet (self-host) is the pragmatic substitute** — one env var unlocks AnimeKai + Zoro + Gogo + Pahe, community-maintained.

Plus: **fix AnimePahe** (FlareSolverr fallback for the CF-gated Kwik host).

## Build order (this effort)

- [x] Research + this list
- [ ] AnimePahe: FlareSolverr fallback for kwik.cx CF-403 (in progress)
- [ ] AnimeParadise (new, API-based, verifiable)
- [ ] HiAnime (MegaCloud via aniwatch decryptor)
- [ ] Consumet: document self-host so AnimeKai/Gogo come for free
