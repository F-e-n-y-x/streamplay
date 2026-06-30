# Design System

A token-based, Geist/Vercel-neutral design system. This is the reference for all UI work in `client/`. Read it before adding or restyling components.

Source files:

- `styles/tokens.css` — the single source of truth for color, type, space, radius, elevation, motion.
- `styles/app.css` — base reset + component classes (primitives in the `EXTENDED DESIGN SYSTEM` section).
- `components/icons.tsx` — Lucide-style inline-SVG icon components.

---

## 1. Principles

- **Token-only values.** Components never use raw hex or px. Always reference `var(--…)`. The only allowed literals are structural (e.g. `1px` borders, fixed control heights already encoded in classes).
- **Neutral-dominant.** The UI is built from the gray ramp. Color is rare.
- **Single accent.** One hue (`--accent`) for focus, links, key emphasis, "playing"/active state. Never decorate with extra hues; status colors (`--success/--warning/--error`) are semantic, never decorative.
- **Dark + light** via `data-theme` on `<html>`. Dark is the default.
- **Lucide icons only.** No emoji as UI chrome. Icons come from `components/icons.tsx`.
- **Motion is quick and quiet.** 120–240ms, `--ease-out`. Respect `prefers-reduced-motion` (durations collapse to 0).

---

## 2. Tokens

### Theme switching

Theme is controlled by the `data-theme` attribute on the root element:

```html
<html data-theme="dark">   <!-- default -->
<html data-theme="light">
```

Each theme redefines the gray ramp + accent/status + shadows. Everything else (semantic roles, spacing, type, radius, motion) resolves through these, so components are theme-agnostic.

### Color ramp

`--gray-1 … --gray-12` — neutral scale. `1` = app background, `12` = highest-contrast text. (Inverts between themes: in dark `gray-1` is near-black; in light it is white.)

### Semantic roles

Prefer these over raw ramp values in components.

| Token | Role |
| --- | --- |
| `--background` | App background (`gray-1`) |
| `--surface` | Card / panel surface (`gray-2`) |
| `--surface-2` | Inset / secondary surface (`gray-3`) |
| `--surface-hover` | Hover fill (`gray-4`) |
| `--overlay` | Modal/drawer scrim |
| `--foreground` | Primary text (`gray-12`) |
| `--muted-foreground` | Secondary text (`gray-11`) |
| `--subtle-foreground` | Tertiary / placeholder text (`gray-10`) |
| `--border` | Default border (`gray-6`) |
| `--border-strong` | Emphasized border (`gray-7`) |
| `--accent` / `--accent-strong` / `--accent-soft` | Accent fill / hover-text / tint |
| `--accent-foreground` | Text on accent fill |
| `--primary` / `--primary-hover` / `--primary-foreground` | Solid primary action (Geist white-on-dark) |
| `--success` / `--warning` / `--error` (+ `-soft`) | Status, semantic only |
| `--ring` | Focus ring (= accent) |

### Type scale

- Font: `--font-sans` (Geist), `--font-mono` (Geist Mono). Base size 14px.
- Sizes: `--text-xs` (12), `--text-sm` (13), `--text-base` (14), `--text-md` (15), `--text-lg` (16), `--text-xl` (18), `--text-2xl` (22), `--text-3xl` (28), `--text-4xl` (36).
- Leading: `--leading-tight` (1.2), `--leading-snug` (1.4), `--leading-base` (1.55).
- Weights: `--weight-normal` (400), `--weight-medium` (500), `--weight-semibold` (600).
- Tracking: `--tracking-tight` (-0.02em), `--tracking-snug` (-0.01em).

### Spacing (4px grid)

`--space-1` (4) · `-2` (8) · `-3` (12) · `-4` (16) · `-5` (20) · `-6` (24) · `-8` (32) · `-10` (40) · `-12` (48) · `-16` (64).

### Radius

`--radius-sm` (4) · `-md` (6, default `--radius`) · `-lg` (8) · `-xl` (12) · `-2xl` (16) · `-full` (9999).

### Shadows

`--shadow-xs` · `-sm` · `-md` · `-lg`. Deeper/quieter in dark, softer in light.

### Motion

- Easing: `--ease-out` (`cubic-bezier(0.16, 1, 0.3, 1)`), `--ease-in-out`.
- Durations: `--duration-1` (120ms), `--duration-2` (180ms), `--duration-3` (240ms).

---

## 3. Components

Class-based primitives in `app.css`. Use these JSX/HTML shapes.

### Button — `.btn` `.btn-primary` `.btn-ghost` `.btn-sm` `.btn-icon`

```jsx
<button className="btn">Default</button>
<button className="btn btn-primary">Save</button>
<button className="btn btn-ghost btn-sm">Cancel</button>
<button className="btn btn-icon btn-ghost"><Settings size={18} /></button>
```

### Input — `.input`

```jsx
<input className="input" placeholder="Search…" />
```

### Custom select — `.select-wrap` + `.chev-down`

```jsx
<div className="select-wrap">
  <select className="input">
    <option>Newest</option>
  </select>
  <ChevronDown size={16} className="chev-down" />
</div>
```

### Badge — `.badge` `.badge-accent` `.badge-success` `.badge-warning` `.badge-error`

```jsx
<span className="badge">12</span>
<span className="badge badge-accent">New</span>
<span className="badge badge-success">Online</span>
```

### Segmented control — `.segmented` / `.seg-opt` (`.active`)

```jsx
<div className="segmented">
  <button className="seg-opt active">Grid</button>
  <button className="seg-opt">List</button>
</div>
```

### Switch — `.switch` (`.on`)

```jsx
<button className={`switch ${on ? "on" : ""}`} onClick={toggle} aria-pressed={on} />
```

### Slider — `.slider`

```jsx
<input type="range" className="slider" min={0} max={100} value={v} onChange={…} />
```

### Dropdown menu — `.menu-wrap` / `.menu` (`.below` `.above` `.right`) / `.menu-label` / `.menu-item` (`.active`)

```jsx
<div className="menu-wrap">
  <button className="btn btn-sm">Sort <ChevronDown size={14} /></button>
  <div className="menu below right">
    <div className="menu-label">Order</div>
    <button className="menu-item active">Newest <span className="mi-meta">↓</span></button>
    <button className="menu-item">Oldest</button>
  </div>
</div>
```

### Removable chip — `.rchip` (`.primary`) / `.idx` / `.x`

```jsx
<span className="rchip primary">
  <span className="idx">1</span> English
  <button className="x" onClick={remove}><X size={12} /></button>
</span>
```

### Tooltip — `[data-tip]`

```jsx
<button className="btn btn-icon" data-tip="Refresh"><RotateCcw size={16} /></button>
```

### Spinner — `.spin`

```jsx
<span className="spin" />
```

### Filter chip — `.fchip` (`.on`) / `.n`

```jsx
<button className={`fchip ${active ? "on" : ""}`}>HD <span className="n">8</span></button>
```

### Grouped source manifest

Structure: `.src-group` (`.open`, `.has-playing`) › `.group-head` (`.chev` `.pname` `.pcount` `.pbest`[`.sd`]) + `.group-body` › `.srow` (`.playing`) (`.led` `.sname` `.tags` › `.tag` `.hd`/`.audio`/`.fmt`).

```jsx
<div className={`src-group ${open ? "open" : ""} ${hasPlaying ? "has-playing" : ""}`}>
  <button className="group-head" onClick={toggle}>
    <ChevronRight size={16} className="chev" />
    <span className="pname">VidSrc</span>
    <span className="pcount">5</span>
    <span className="pbest">1080p</span>
  </button>
  <div className="group-body">
    <button className={`srow ${playing ? "playing" : ""}`}>
      <span className="led" />
      <span className="sname">Source A</span>
      <span className="tags">
        <span className="tag hd">HD</span>
        <span className="tag audio">EAC3</span>
        <span className="tag fmt">MP4</span>
      </span>
    </button>
  </div>
</div>
```

### Card / poster — `.grid` / `.poster`

```jsx
<div className="grid">
  <a className="poster">
    <img className="img" src={url} />
    <div className="body">
      <div className="t">Title</div>
      <div className="sub">2024 · Movie</div>
    </div>
  </a>
</div>
```

### Tabs — `.tabs` / `.tab` (`.active`)

```jsx
<div className="tabs">
  <button className="tab active">Season 1</button>
  <button className="tab">Season 2</button>
</div>
```

### Table — `.table-wrap` / `table.tbl`

```jsx
<div className="table-wrap">
  <table className="tbl">
    <thead><tr><th>Provider</th><th>Status</th></tr></thead>
    <tbody><tr><td>VidSrc</td><td>OK</td></tr></tbody>
  </table>
</div>
```

### Modal — `.modal-overlay` / `.modal` / `.modal-head` `.modal-body` `.modal-foot` / `.field` / `.hint`

```jsx
<div className="modal-overlay">
  <div className="modal">
    <div className="modal-head"><h3>Add provider</h3></div>
    <div className="modal-body">
      <div className="field">
        <label>Name</label>
        <input className="input" />
        <div className="hint">Shown in the source list.</div>
      </div>
    </div>
    <div className="modal-foot">
      <button className="btn btn-ghost">Cancel</button>
      <button className="btn btn-primary">Save</button>
    </div>
  </div>
</div>
```

### Drawer — `.overlay` + `.drawer` (`.drawer-head` `.drawer-body`)

```jsx
<>
  <div className="overlay" onClick={close} />
  <aside className="drawer">
    <div className="drawer-head"><h3>Sources</h3></div>
    <div className="drawer-body">…</div>
  </aside>
</>
```

### Skeleton — `.skeleton`

```jsx
<div className="skeleton" style={{ height: "var(--space-12)" }} />
```

### Empty — `.empty`

```jsx
<div className="empty">No results found.</div>
```

---

## 4. Icons

Icons live in `components/icons.tsx` — Lucide-style inline SVGs (stroke-width 2, `currentColor`, `viewBox 0 0 24 24`). Each takes a `size` prop (default 18) and any `SVGProps`. Color follows text color; tint with `style={{ color: "var(--accent)" }}` or a parent class.

```jsx
import { Play } from "../components/icons";
<Play size={16} />
```

Available names:

`Play` · `Pause` · `Search` · `Sun` · `Moon` · `Plus` · `Check` · `Star` · `Bookmark` · `Activity` · `Settings` · `ChevronLeft` · `ChevronRight` · `ChevronDown` · `ChevronUp` · `X` · `Film` · `Tv` · `Clock` · `Layers` · `Volume2` · `VolumeX` · `Maximize` · `RotateCcw` · `Filter` · `SlidersHorizontal` · `Subtitles` · `Languages` · `Gauge` · `Globe` · `Trash2` · `Download` · `Cast` · `Loader` · `Wifi` · `WifiOff`

---

## 5. Adding a new component

1. **Compose first.** Build from existing primitives + tokens before writing anything new.
2. **New classes go in `app.css` only**, in the `EXTENDED DESIGN SYSTEM` section, using `var(--…)` values exclusively.
3. **Never hardcode colors** (no hex, no `rgb()` except token-defined scrims). Use semantic roles, fall back to the gray ramp only when no role fits.
4. **Spacing/radius/type/motion** must come from tokens — no magic numbers.
5. **Icons** come from `components/icons.tsx`; add new ones there following the existing `base(p)` pattern. No emoji.
6. **Theme test:** verify in both `data-theme="dark"` and `light`. If it only looks right in one, you hardcoded something.
