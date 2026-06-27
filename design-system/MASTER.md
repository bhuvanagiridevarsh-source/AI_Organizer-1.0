# System Janitor — Design System MASTER
**Aesthetic:** Minimal Editorial · Swiss Modernism 2.0 · Geometric Shadow
**Generated:** 2026-06-27

---

## Philosophy

One vibrant accent in a monochrome world. Depth through hard shadow offsets, not blur. Typography carries the hierarchy — spacing does the rest. No gradient noise. No glassmorphism. No generic system fonts.

---

## Color Tokens

### Primary Palette (dark-first)

| Token | Value | Role |
|---|---|---|
| `--void` | `#09090C` | Deepest background — body |
| `--surface` | `#111115` | Card / panel surface |
| `--surface-2` | `#18181E` | Elevated surface |
| `--surface-3` | `#1F1F27` | Highest elevation / topbar |
| `--ink` | `#F0EDE6` | Primary text — warm white |
| `--ink-2` | `#9C9890` | Secondary text |
| `--ink-3` | `#565250` | Muted / placeholder |
| `--ink-4` | `#2E2C28` | Very subtle / decorative |
| `--accent` | `#CEFF00` | Electric chartreuse — THE single punch |
| `--accent-dim` | `rgba(206,255,0,0.12)` | Accent tint for surfaces |
| `--accent-fg` | `#09090C` | Text on accent background |
| `--line` | `rgba(240,237,230,0.06)` | Hairline dividers |
| `--line-2` | `rgba(240,237,230,0.12)` | Visible borders |
| `--line-3` | `rgba(240,237,230,0.24)` | Strong borders / focus |

### Semantic Color Tokens

| Token | Value | Role |
|---|---|---|
| `--color-success` | `#22C55E` | Success states, active indicators |
| `--color-success-dim` | `rgba(34,197,94,0.12)` | Success surface tint |
| `--color-error` | `#FF4040` | Error, destructive actions |
| `--color-error-dim` | `rgba(255,64,64,0.10)` | Error surface tint |
| `--color-warning` | `#F59E0B` | Warning, caution states |
| `--color-warning-dim` | `rgba(245,158,11,0.10)` | Warning surface tint |
| `--color-info` | `#38BDF8` | Info, links, highlights |
| `--color-info-dim` | `rgba(56,189,248,0.10)` | Info surface tint |

### Light Mode Overrides (`html.light`)

| Token | Value |
|---|---|
| `--void` | `#F7F6F2` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F2F1EC` |
| `--surface-3` | `#E8E6DF` |
| `--ink` | `#0E0D0A` |
| `--ink-2` | `#4A4742` |
| `--ink-3` | `#908D87` |
| `--ink-4` | `#C8C5BF` |
| `--line` | `rgba(14,13,10,0.07)` |
| `--line-2` | `rgba(14,13,10,0.14)` |
| `--line-3` | `rgba(14,13,10,0.28)` |
| `--accent` | `#5500FF` | Adjusted for light mode — electric violet |

---

## Geometric Shadow Tokens

Hard offset shadows — no blur radius. Depth is created by displacement, not diffusion.

| Token | Value | Use |
|---|---|---|
| `--shadow-1` | `1px 1px 0 rgba(0,0,0,0.9)` | Pressed state, tight inset |
| `--shadow-2` | `3px 3px 0 rgba(0,0,0,0.85)` | Default card depth |
| `--shadow-3` | `6px 6px 0 rgba(0,0,0,0.8)` | Elevated panels, dropdowns |
| `--shadow-4` | `10px 10px 0 rgba(0,0,0,0.75)` | Modals, drawers |
| `--shadow-accent` | `3px 3px 0 var(--accent)` | Editorial accent pop on key CTAs |
| `--shadow-error` | `3px 3px 0 var(--color-error)` | Error state emphasis |

---

## Typography

### Fonts

| Role | Family | Source |
|---|---|---|
| **Display** — wordmark, section anchors | `Bricolage Grotesque` | Google Fonts (variable) |
| **UI** — all interface copy, labels, body | `Plus Jakarta Sans` | Google Fonts (variable) |
| **Mono** — data, paths, keys, stats | `JetBrains Mono` | Google Fonts |

**Google Fonts import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..60,300..800&family=JetBrains+Mono:ital,wght@0,300..500;1,300..500&family=Plus+Jakarta+Sans:ital,wght@0,300..800;1,300..800&display=swap');
```

### Type Scale (4pt base)

| Token | Size | Weight | Use |
|---|---|---|---|
| `--text-2xs` | `10px` | 500 | Timestamps, tooltips only |
| `--text-xs` | `11px` | 500 | Caps labels (uppercase + tracking) |
| `--text-sm` | `13px` | 400 | Secondary UI text |
| `--text-base` | `15px` | 400 | **Primary body** (up from 13px) |
| `--text-md` | `17px` | 400/500 | Lead copy, panel sub-headers |
| `--text-lg` | `20px` | 600 | Section titles |
| `--text-xl` | `26px` | 700 | Modal / overlay headers |
| `--text-2xl` | `34px` | 700 | Display headings |
| `--text-3xl` | `46px` | 800 | Hero / wordmark |

### Hierarchy Rules
- Labels (caps): `text-xs` + `font-weight: 600` + `letter-spacing: 0.10em` + `uppercase`
- Body: `text-base` + `line-height: 1.6`
- Data / mono values: `JetBrains Mono` + `text-sm` + `font-weight: 400`
- Section anchors: `Bricolage Grotesque` + `text-xl` + `font-weight: 700` + `letter-spacing: -0.02em`

---

## Spacing (4pt grid — strict)

```
4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80 · 96
```

Never: 5, 6, 7, 9, 10, 11, 13, 14, 17, 18, 28

---

## Border Radius

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | `2px` | Inputs, inline badges |
| `--radius-sm` | `4px` | Buttons, chips, table rows |
| `--radius` | `6px` | Cards, panels |
| `--radius-lg` | `8px` | Modals, overlays |
| `--radius-pill` | `999px` | Status dots, toggle tracks only |

---

## Animation

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances, open |
| `--ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` | Exits, close |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | State changes |
| `--dur-fast` | `120ms` | Press feedback, hover |
| `--dur-base` | `200ms` | State transitions |
| `--dur-slow` | `340ms` | Overlays, panels |

**Press feedback:** Scale `0.97` on `:active` at `120ms ease-out`. Never `transform: none !important`.

---

## Layout Grid

**Shell:** `[rail: 48px] [content: 1fr]`
**Rail:** Collapsed icon strip. Labels at 10px caps. Active item: accent left-border 2px + surface-2 background.
**Content:** Internal 3-col optional: `[context: 180px] [main: 1fr] [detail: 220px]`. Default 1-col.
**Topbar:** 44px height. Logo left, actions right. No center content.

---

## Button System

| Variant | Background | Border | Text | Active shadow |
|---|---|---|---|---|
| Default | `surface-2` | `line-2` | `ink-2` | `shadow-1` |
| Primary | `accent-dim` | `accent` 40% | `accent` | `shadow-accent` |
| Success | `color-success-dim` | `color-success` 40% | `color-success` | `shadow-1` |
| Danger | `color-error-dim` | `color-error` 40% | `color-error` | `shadow-error` |
| Ghost | transparent | `line` | `ink-3` | none |

**All buttons:** `border-radius: var(--radius-sm)` · `padding: 6px 14px` · `font-size: var(--text-sm)` · `transition: var(--dur-fast)` · `:active { transform: scale(0.97) }` · NO `!important`

---

## Settings Panel

- Background: `var(--surface-2)` — no hardcoded `rgba` values
- Header `h2`: `color: var(--ink)` — never hardcoded `#fff`
- Scrim: `rgba(0,0,0,0.72)` with `backdrop-filter: blur(4px)` — mode-agnostic
- Width: `480px` · `border-radius: var(--radius-lg)` · `border: 1px solid var(--line-2)`
- Shadow: `var(--shadow-4)`

---

## Legacy Compatibility Aliases

These map old `--ds-*` vars to new tokens so existing modal HTML doesn't break:

```css
--ds-text:     var(--ink);
--ds-text-dim: var(--ink-3);
--ds-surface:  var(--surface);
--ds-panel:    var(--surface-2);
--ds-border:   var(--line-2);
--ds-border-h: var(--line-3);
--ds-emerald:  var(--color-success);
--ds-red:      var(--color-error);
--ds-amber:    var(--color-warning);
--ds-cyan:     var(--color-info);
--ds-void:     var(--void);
--ds-neon:     var(--accent);
--ds-blue:     var(--color-info);
--ds-purple:   var(--accent);
```

---

## Anti-Patterns (Do Not Use)

- No radial gradients on body background
- No `backdrop-filter: blur(20px+)` on persistent elements (performance on Electron)
- No `!important` in component CSS
- No raw hex values outside this file — always use tokens
- No `transform: none !important` — this kills press feedback
- No `box-shadow` with blur-radius for depth — use `--shadow-*` geometric tokens
- No font sizes below 11px anywhere
- No spacing values off the 4pt grid
- No hardcoded `#fff` or `color: white` — use `var(--ink)` or `var(--accent-fg)`
