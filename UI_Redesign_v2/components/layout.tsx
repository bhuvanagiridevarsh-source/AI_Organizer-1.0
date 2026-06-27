/**
 * layout.tsx — App shell, TopBar, and z-index layer system
 * Design system: Minimal Editorial · Swiss Modernism 2.0
 * Tokens from design-system/MASTER.md
 */

import React, {
  useState,
  useEffect,
  useRef,
  CSSProperties,
  ReactNode,
  KeyboardEvent,
} from "react";

// ── Z-index layers ────────────────────────────────────────────────────────────
// Explicit stacking context. Never use ad-hoc numbers outside this enum.
export const Z = {
  base:    0,
  content: 1,
  rail:    10,
  topbar:  20,
  drawer:  40,   // mobile sidebar
  overlay: 100,
  toast:   200,
  tooltip: 300,
} as const;

// ── Breakpoints (px) ─────────────────────────────────────────────────────────
export const BP = {
  sm:  480,   // compact phones
  md:  768,   // tablet / small laptop
  lg:  1024,  // desktop
  xl:  1280,  // wide desktop
} as const;

// ── useBreakpoint hook ───────────────────────────────────────────────────────
function useBreakpoint(): keyof typeof BP | "xs" {
  const [bp, setBp] = useState<keyof typeof BP | "xs">("lg");
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      if (w < BP.sm)       setBp("xs");
      else if (w < BP.md)  setBp("sm");
      else if (w < BP.lg)  setBp("md");
      else if (w < BP.xl)  setBp("lg");
      else                 setBp("xl");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return bp;
}

// ── Fluid type helper ─────────────────────────────────────────────────────────
// Returns a CSS clamp() value that scales between minPx at minVw and maxPx at maxVw.
function fluidType(
  minPx: number,
  maxPx: number,
  minVw = 480,
  maxVw = 1280
): string {
  const slope = (maxPx - minPx) / (maxVw - minVw);
  const intercept = minPx - slope * minVw;
  return `clamp(${minPx}px, ${intercept.toFixed(2)}px + ${(slope * 100).toFixed(3)}vw, ${maxPx}px)`;
}

// ── Micro-interaction hook ────────────────────────────────────────────────────
function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hovered, setHovered] = useState(false);
  return [
    hovered,
    { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
  ];
}

function usePress(): [boolean, { onPointerDown: () => void; onPointerUp: () => void; onPointerLeave: () => void }] {
  const [pressed, setPressed] = useState(false);
  return [
    pressed,
    {
      onPointerDown: () => setPressed(true),
      onPointerUp:   () => setPressed(false),
      onPointerLeave: () => setPressed(false),
    },
  ];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TopBarAction {
  id: string;
  label: ReactNode;
  title?: string;
  onClick: () => void;
  active?: boolean;
  variant?: "default" | "accent" | "ghost";
}

export interface TopBarProps {
  wordmark?: string;
  accentChar?: string;          // character rendered in accent color after wordmark
  scanLabel?: string | null;    // live AI status string
  learnerActive?: boolean;
  actions?: TopBarAction[];
  onAsk?: () => void;
  kbdHint?: string[];           // e.g. ["⌘", "K"]
  meta?: string;                // e.g. "718 files · 6 collections"
}

export interface AppShellProps {
  topBar: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  /** Overlays (modals, ask panel) rendered at z-index overlay layer */
  overlays?: ReactNode;
  sidebarOpen?: boolean;        // controlled for mobile drawer
  onSidebarClose?: () => void;
}

// ── TopBar ────────────────────────────────────────────────────────────────────

export function TopBar({
  wordmark = "organize",
  accentChar = ".",
  scanLabel,
  learnerActive = false,
  actions = [],
  onAsk,
  kbdHint = ["⌘", "K"],
  meta,
}: TopBarProps) {
  const bp = useBreakpoint();
  const isMobile = bp === "xs" || bp === "sm";

  const root: CSSProperties = {
    display:        "flex",
    alignItems:     "center",
    gap:            "var(--sp-4)",
    padding:        `0 ${isMobile ? "var(--sp-4)" : "var(--sp-5)"}`,
    height:         "var(--topbar-h)",
    minHeight:      "var(--topbar-h)",
    background:     "var(--topbar-bg)",
    borderBottom:   "1px solid var(--line-2)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    position:       "relative",
    zIndex:         Z.topbar,
    flexShrink:     0,
    transition:     "background var(--dur-slow) var(--ease-std)",
  };

  return (
    <header style={root} role="banner">
      <Wordmark text={wordmark} accent={accentChar} pulse={learnerActive} />

      {!isMobile && <VDivider />}

      {meta && !isMobile && (
        <span
          style={{
            fontFamily:    "var(--font-mono)",
            fontSize:      "var(--text-2xs)",
            color:         "var(--ink-3)",
            letterSpacing: "0.08em",
            whiteSpace:    "nowrap",
          }}
        >
          {meta}
        </span>
      )}

      {scanLabel && !isMobile && (
        <>
          <VDivider />
          <DataPill label={scanLabel} active={learnerActive} />
        </>
      )}

      <div style={{ flex: 1 }} />

      {/* Slot for custom action buttons */}
      {actions.map((a) => (
        <TopBarBtn key={a.id} {...a} />
      ))}

      {onAsk && (
        <>
          {actions.length > 0 && <VDivider />}
          <AskButton onClick={onAsk} kbdHint={isMobile ? [] : kbdHint} />
        </>
      )}
    </header>
  );
}

// ── Wordmark ──────────────────────────────────────────────────────────────────

interface WordmarkProps { text: string; accent: string; pulse: boolean; }

function Wordmark({ text, accent, pulse }: WordmarkProps) {
  return (
    <div
      style={{
        display:    "flex",
        alignItems: "center",
        gap:        "var(--sp-2)",
        flexShrink: 0,
      }}
    >
      <StatusOrb pulse={pulse} />
      <span
        style={{
          fontFamily:    "var(--font-display)",
          fontWeight:    700,
          fontSize:      fluidType(15, 18),
          color:         "var(--ink)",
          letterSpacing: "-0.02em",
          lineHeight:    1,
          userSelect:    "none",
        }}
      >
        {text}
        <span
          style={{ color: "var(--accent)", marginLeft: 1 }}
          aria-hidden
        >
          {accent}
        </span>
      </span>
    </div>
  );
}

// ── StatusOrb — pulsing indicator for AI learner ──────────────────────────────

function StatusOrb({ pulse }: { pulse: boolean }) {
  return (
    <span
      style={{
        display:       "block",
        width:         6,
        height:        6,
        borderRadius:  "var(--radius-pill)",
        background:    pulse ? "var(--accent)" : "var(--ink-4)",
        flexShrink:    0,
        animation:     pulse ? "seal-pulse 2s ease-in-out infinite" : "none",
        transition:    "background var(--dur-base) var(--ease-std)",
      }}
      role="status"
      aria-label={pulse ? "AI active" : "AI idle"}
    />
  );
}

// ── DataPill ─────────────────────────────────────────────────────────────────

function DataPill({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      style={{
        display:       "flex",
        alignItems:    "center",
        gap:           "var(--sp-1)",
        padding:       "3px 8px",
        background:    active ? "var(--accent-dim)" : "var(--surface-2)",
        border:        `1px solid ${active ? "rgba(206,255,0,0.20)" : "var(--line)"}`,
        borderRadius:  "var(--radius-pill)",
        fontFamily:    "var(--font-mono)",
        fontSize:      "var(--text-2xs)",
        color:         active ? "var(--accent)" : "var(--ink-3)",
        letterSpacing: "0.06em",
        whiteSpace:    "nowrap",
        transition:    "background var(--dur-base) var(--ease-std), color var(--dur-base) var(--ease-std)",
      }}
    >
      {active && (
        <span
          style={{
            width:      4,
            height:     4,
            borderRadius: "var(--radius-pill)",
            background: "var(--accent)",
            flexShrink: 0,
            animation:  "dot-breathe 1.5s ease-in-out infinite",
          }}
        />
      )}
      {label}
    </div>
  );
}

// ── AskButton ─────────────────────────────────────────────────────────────────

interface AskButtonProps { onClick: () => void; kbdHint: string[]; }

function AskButton({ onClick, kbdHint }: AskButtonProps) {
  const [hovered, hoverHandlers] = useHover();
  const [pressed, pressHandlers] = usePress();

  const style: CSSProperties = {
    display:       "flex",
    alignItems:    "center",
    gap:           "var(--sp-2)",
    padding:       "5px 12px",
    border:        `1px solid ${hovered ? "rgba(206,255,0,0.45)" : "rgba(206,255,0,0.22)"}`,
    background:    hovered ? "rgba(206,255,0,0.14)" : "var(--accent-dim)",
    borderRadius:  "var(--radius-sm)",
    fontFamily:    "var(--font-display)",
    fontWeight:    600,
    fontSize:      "var(--text-sm)",
    color:         "var(--accent)",
    cursor:        "pointer",
    flexShrink:    0,
    transform:     pressed ? "scale(0.96)" : "scale(1)",
    transition:    [
      "background var(--dur-fast) var(--ease-std)",
      "border-color var(--dur-fast) var(--ease-std)",
      "transform var(--dur-fast) var(--ease-out)",
    ].join(", "),
  };

  return (
    <button
      onClick={onClick}
      style={style}
      aria-label="Open ask panel"
      {...hoverHandlers}
      {...pressHandlers}
    >
      ask
      {kbdHint.length > 0 && (
        <KbdChord keys={kbdHint} />
      )}
    </button>
  );
}

// ── KbdChord ──────────────────────────────────────────────────────────────────

function KbdChord({ keys }: { keys: string[] }) {
  return (
    <span
      style={{
        display:    "inline-flex",
        gap:        2,
        alignItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize:   "var(--text-2xs)",
        color:      "var(--ink-4)",
      }}
    >
      {keys.map((k, i) => (
        <span
          key={i}
          style={{
            padding:      "1px 4px",
            border:       "1px solid var(--line)",
            borderRadius: "var(--radius-xs)",
            minWidth:     14,
            textAlign:    "center",
          }}
        >
          {k}
        </span>
      ))}
    </span>
  );
}

// ── TopBarBtn ─────────────────────────────────────────────────────────────────

function TopBarBtn({ label, title, onClick, active, variant = "default" }: TopBarAction) {
  const [hovered, hoverHandlers] = useHover();
  const [pressed, pressHandlers] = usePress();

  const bg = (() => {
    if (variant === "accent") return hovered ? "rgba(206,255,0,0.14)" : "var(--accent-dim)";
    if (active || hovered)    return "var(--surface-2)";
    return "var(--surface)";
  })();

  const border = (() => {
    if (variant === "accent") return hovered ? "rgba(206,255,0,0.45)" : "rgba(206,255,0,0.22)";
    if (active)               return "var(--line-3)";
    if (hovered)              return "var(--line-2)";
    return "var(--line)";
  })();

  const color = (() => {
    if (variant === "accent")   return "var(--accent)";
    if (active || hovered)      return "var(--ink)";
    return "var(--ink-3)";
  })();

  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display:       "flex",
        alignItems:    "center",
        justifyContent:"center",
        padding:       "5px 10px",
        background:    bg,
        border:        `1px solid ${border}`,
        borderRadius:  "var(--radius-sm)",
        fontSize:      "var(--text-sm)",
        color,
        cursor:        "pointer",
        flexShrink:    0,
        transform:     pressed ? "scale(0.97)" : "scale(1)",
        transition:    [
          "background var(--dur-fast) var(--ease-std)",
          "border-color var(--dur-fast) var(--ease-std)",
          "color var(--dur-fast) var(--ease-std)",
          "transform var(--dur-fast) var(--ease-out)",
        ].join(", "),
      }}
      {...hoverHandlers}
      {...pressHandlers}
    >
      {label}
    </button>
  );
}

// ── VDivider ──────────────────────────────────────────────────────────────────

function VDivider() {
  return (
    <div
      aria-hidden
      style={{
        width:      1,
        alignSelf:  "stretch",
        margin:     "10px 0",
        background: "var(--line-2)",
        flexShrink: 0,
      }}
    />
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────
// Manages the full-height flex shell: topbar → [rail | main | inspector].
// On mobile (< md) the sidebar becomes a drawer overlaid at z-index drawer.

export function AppShell({
  topBar,
  sidebar,
  children,
  inspector,
  overlays,
  sidebarOpen = false,
  onSidebarClose,
}: AppShellProps) {
  const bp = useBreakpoint();
  const isMobile = bp === "xs" || bp === "sm";
  const drawerRef = useRef<HTMLDivElement>(null);

  // Trap focus and close on Escape for mobile drawer
  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onSidebarClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile, sidebarOpen, onSidebarClose]);

  return (
    <div
      style={{
        display:       "flex",
        flexDirection: "column",
        height:        "100dvh",       // 100dvh: mobile address bar aware
        background:    "var(--void)",
        color:         "var(--ink)",
        fontFamily:    "var(--font-ui)",
        fontSize:      "var(--text-base)",
        overflow:      "hidden",
        position:      "relative",
        zIndex:        Z.base,
      }}
    >
      {/* ── Topbar ────────────────────────────────────────── */}
      {topBar}

      {/* ── Body row ─────────────────────────────────────── */}
      <div
        style={{
          display:  "flex",
          flex:     1,
          minHeight: 0,
          position: "relative",
        }}
      >
        {/* Desktop rail — always visible at ≥ md */}
        {!isMobile && (
          <div
            style={{
              position:  "relative",
              zIndex:    Z.rail,
              flexShrink: 0,
            }}
          >
            {sidebar}
          </div>
        )}

        {/* Mobile drawer overlay */}
        {isMobile && (
          <>
            {/* Scrim */}
            {sidebarOpen && (
              <button
                aria-label="Close navigation"
                onClick={onSidebarClose}
                style={{
                  position:   "fixed",
                  inset:      0,
                  background: "var(--overlay-bg)",
                  border:     "none",
                  zIndex:     Z.drawer - 1,
                  cursor:     "default",
                }}
              />
            )}
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              style={{
                position:  "fixed",
                top:       0,
                left:      0,
                bottom:    0,
                width:     "min(280px, 80vw)",
                zIndex:    Z.drawer,
                transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
                transition: "transform var(--dur-slow) var(--ease-out)",
                boxShadow: sidebarOpen ? "var(--shadow-4)" : "none",
              }}
            >
              {sidebar}
            </div>
          </>
        )}

        {/* Main content */}
        <main
          style={{
            flex:         1,
            display:      "flex",
            minWidth:     0,
            overflow:     "hidden",
            position:     "relative",
            zIndex:       Z.content,
          }}
        >
          <div
            style={{
              flex:       1,
              overflowY:  "auto",
              overflowX:  "hidden",
              position:   "relative",
              // Fluid content max-width: comfortable reading line on wide screens
              maxWidth:   "1440px",
            }}
          >
            {children}
          </div>

          {/* Inspector panel — slides in from right */}
          {inspector && (
            <aside
              style={{
                flexShrink:   0,
                width:        isMobile ? "100%" : "clamp(220px, 25vw, 340px)",
                borderLeft:   "1px solid var(--line-2)",
                background:   "var(--surface)",
                overflowY:    "auto",
                position:     isMobile ? "fixed" : "relative",
                inset:        isMobile ? "0 0 0 auto" : undefined,
                zIndex:       isMobile ? Z.overlay : Z.content,
                boxShadow:    isMobile ? "var(--shadow-4)" : "none",
              }}
              aria-label="File inspector"
            >
              {inspector}
            </aside>
          )}
        </main>
      </div>

      {/* Overlays — modals, ask panel, toasts */}
      {overlays && (
        <div
          style={{
            position: "fixed",
            inset:    0,
            zIndex:   Z.overlay,
            pointerEvents: "none",
          }}
          aria-live="polite"
        >
          {overlays}
        </div>
      )}
    </div>
  );
}

// ── Named exports for external consumers ─────────────────────────────────────
export { VDivider, KbdChord, DataPill, StatusOrb, fluidType, useHover, usePress, useBreakpoint };
