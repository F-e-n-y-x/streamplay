# StreamPlay design system v2: "Lights down"

How to build UI here. The full spec, including page layouts, lives in the UX docs. This file covers what the code gives you.
Live catalogue: **`/__ui`**. It shows every component in every state.

## Rules that decide most questions

1. **The picture is the interface.** Chrome is neutral and dark. Don't use gradients (the two scrims are the only exception), glow, colored shadows, or decorative badges.
2. **One obvious next step.** Each view has one `primary` (red) button. Everything else is secondary (tonal), ghost, or link.
3. **Shape means something.** A rectangle (radius 8) is a button. A pill is a filter chip. A circle is an icon button, avatar, or switch. An underline is a tab. **Outline buttons don't exist.**
4. **Red budget:** at most one red fill per viewport, plus progress bars. Selected states are never red. Use white text + underline for tabs, `--surface-2` + Check for rows, and an inverted fill for filter chips.
5. **Status is a dot + text, never color alone.**
6. **Dark is the default for everyone.** Light is opt-in in Settings. Media surfaces (`.media-dark`) stay dark in both themes.

## Tokens (`tokens.css`)

| Group | Tokens |
|---|---|
| Ground/surfaces | `--background #0A0A0C` · `--surface #141418` (panels, menus) · `--surface-2 #1E1E23` (tonal fill, selected row) · `--surface-3 #2A2A31` (hover/pressed, tracks) |
| Text | `--foreground #F4F4F5` · `--muted-foreground #ABABB4` (secondary) · `--subtle-foreground #92929C` (tertiary, ≥12px only) |
| Lines | `--border` (hairlines) · `--border-strong` (chip outline, inputs) |
| Action | `--accent #D92632` (the primary button, progress) · `--accent-hover` · `--accent-soft` (current-episode tint) · `--accent-strong` (red as text) |
| Neutral solid | `--primary` / `--primary-foreground` (dialog confirm, "Go home") |
| Status | `--success` · `--warning` · `--error` (+ `-soft`) |
| Overlays | `--overlay` (scrim) · `--scrim-media` (text over art) · `--player-scrim-top/-bottom` |
| Elevation | `--elevation-2` (menus, toast) · `--elevation-3` (dialog). Panels and cards get no shadow. |
| Type | `font: var(--type-display \| -h1 \| -h2 \| -title \| -body \| -label \| -meta \| -caption)`, letter-spacing `--track-display/-h1/-h2/-caption`. Responsive at 768/1100. Utility classes `.t-h1` etc. |
| Space | `--space-1…20` (4px grid). 4/8/12 inside components, 16/24 between groups, 40 (phone 32) between sections. |
| Radius | `--radius-xs 4` badges/progress · `-sm 6` stills/menu rows · `-md 8` buttons/inputs/posters · `-lg 12` menus/panel edge · `-xl 16` sheet/player · `-full` chips/circles only |
| Controls | `--control-sm 32` · `-md 40` · `-lg 48` · `--hit-min 44` (coarse pointer) |
| Motion | `--duration-1 120` hover · `-2 200` menus/tabs · `-3 280` panels · `--duration-exit 180` · `--ease-out` (enter) · `--ease-in` (exit). Reduced motion sets all of them to 0. |

Legacy names (`--text-*`, `--weight-*`, `--shadow-*`, `--radius-2xl`, `--primary-color`, …) are aliases in tokens.css §4. Don't use them in new code.

**Motion:** animate `transform`, `opacity`, and colors only. Never width, height, margin, or padding. Progress uses `transform: scaleX(var(--p))`.
**Meta strings:** `<div class="meta-line"><span>2008</span><span>Series</span></div>` draws the `·` separators. Use at most 3 items, and drop any item the page already implies.

## Components (`components/ui`, import from `components/ui`)

| Component | Use | Key props |
|---|---|---|
| `Button` | All text buttons | `variant` `primary` (red, one per view) · `secondary` (tonal, default) · `ghost` · `solid` (neutral-solid) · `danger` · `link` · `media` (tonal on art/player); `size` sm/md/lg; `icon`; `meta` ("32 min left" after a hairline, Resume only); `loading`; `full`; `to` (router link) |
| `IconButton` | Icon-only actions | `label` (required: aria-label + tooltip), `variant` ghost/tonal/media, `size`, `pressed` (toggle), `to` |
| `Badge` | Quality, audio language, count, New, Watched. **Nothing else.** | children |
| `StatusDot` | Source/provider health, always next to text | `tone` success/warning/error/neutral |
| `FilterChip` | Toggle filter | `selected`, `count` |
| `InputChip` | Removable value | `onRemove`, `removeLabel` |
| `SegmentedControl` | 2–4 options that change the view immediately (Sub/Dub) | `value`, `options`, `onChange`, `label` |
| `Tabs` | Sort, search type, seasons ≤6 | `value`, `items`, `onChange`, `label`, `id` (tab ids `${id}-tab-${value}`), `accent` (red ink, player panels only) |
| `ListRow` / `ListGroup` | Settings rows, choice lists, source rows | `title`, `description`, `leading`, `value`, `trailing`, `kind` plain/nav/toggle/choice, `checked`, `onClick`/`to`, `role`, `tooltip`; group: `role` group/radiogroup, `divided` |
| `Switch` | Standalone toggle (inside a row use `kind="toggle"`) | `checked`, `onChange`, `label` |
| `Panel` | **The** overlay: right side panel, or a bottom sheet in phone portrait | `open`, `onClose`, `title`, `onBack` + `view` (sub-views), `subheader`, `footer`, `container` (e.g. the player element; `null` = not ready), `scrim` (false in the player), `initialFocus` |
| `Menu` | Anchored choice/action menu; a sheet on phones when >6 items | `label`, `items` [{label, onSelect, checked?, meta?, group?, disabled?}], `trigger={(p) => <Button {...p}/>}`, `align` |
| `Toaster` / `toast()` | One-sentence feedback | `toast(msg, {tone, action:{label,onClick}})`. `<Toaster/>` is mounted in App. The player mounts `<Toaster placement="top"/>` inside its element, and while that's mounted it takes over |
| `Skeleton` / `SkeletonText` | Loading in the final shape | `width`, `height`, `aspect`, `radius`; `lines` |
| `StateMessage` | Empty, error, offline, not found | `kind`, `title`, `body`, `actions`, `details` (collapsed technical text), `align` start/center |
| `SourceStatus` | The line under the player | `state` finding/starting/playing/switching/web/failed/offline, `provider`, `quality`, `audio`, `slow`, `checked`/`total`, `onChangeSource` |
| `EpisodeListItem` / `EpisodeList` / `EpisodeListSkeleton` | Episodes panel, Watch rail, Title page | `number`, `title`, `still`, `runtime`, `overview`, `airDate`, `progress` 0–1, `watched`, `current`, `size` panel/page, `to`/`onSelect`. The list adds ↑/↓ navigation |
| `rove()` | Arrow-key roving for your own composite widgets | `(event, selector, axis)` |

`ErrorState` (components/ErrorBoundary) now renders `StateMessage`. Raw errors go into "Technical details".

### Behaviour you get for free
- **Panel:** dialog semantics, focus moves to the current item (or the first control), Tab is trapped, everything else is `inert`, Esc / scrim tap / swipe-down (sheet) closes, and focus returns to the opener. A sheet with tall content opens at 60svh and expands when you drag up or scroll. Sub-views slide in. Use one panel at a time and never stack them.
- **Inside the player:** pass `container={playerEl}` and `scrim={false}`. The side panel then fills the player (works in fullscreen) and the video stays visible. In phone portrait it becomes a viewport sheet. Note: `position: fixed` breaks if an ancestor has `transform` or `filter`.
- **Touch:** every target reaches 44px under `(pointer: coarse)`. Icon buttons, chips, and switches extend their hit area with `::before`, so the visuals stay compact.
- **Hover styles** only apply under `(hover: hover)`.

## CSS (`app.css` → PRIMITIVES section)
The classes the components emit are `.btn .btn-accent/-solid/-ghost/-danger/-link/-media/-sm/-lg`, `.icon-btn`, `.badge`, `.status-dot`, `.filter-chip`, `.input-chip`, `.segmented/.seg-opt`, `.tabs/.tab/.tabs-ink`, `.switch`, `.list-row`, `.menu/.menu-item`, `.panel*`, `.toast*`, `.skeleton`, `.state-msg*`, `.source-status`, `.epi*`.
Legacy aliases restyle old markup into the new look, so pages render correctly until they're migrated: `.btn-primary` (= solid), `.btn-outline` (= media), `.btn-sub`, `.btn-icon`, `.fab`, `.rchip`, `.seg-opt.active`, `.tab.active`, `.switch.on`, `.menu-item.active`, `.badge-success/-warning/-error`, `.state*`. Delete each alias once nothing uses it.

## Don't
- Don't add pill buttons, outline buttons, or more than three buttons in a row (put extras in a ⋯ `Menu`).
- Don't use chips for genres, navigation, or actions.
- Don't use badges for type, genre, format (M3U8/IFRAME), "VLC", "IMDb", or "#1".
- Don't show "Loading…" text on its own. Spinners belong only in buttons and the player.
- Don't apologize or show raw errors in copy.
- Don't use emoji or unicode glyphs as icons. Use `components/icons.tsx`.
