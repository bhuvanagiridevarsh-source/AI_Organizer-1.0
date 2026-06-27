/**
 * sidebar.tsx — SideRail / Sidebar navigation component
 * Design system: Minimal Editorial · Swiss Modernism 2.0
 * Tokens from design-system/MASTER.md
 */

import React, {
  useState,
  useRef,
  useEffect,
  CSSProperties,
  ReactNode,
  KeyboardEvent,
} from "react";

import { Z, useHover, usePress, useBreakpoint, fluidType } from "./layout";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SystemStatus = "ready" | "active" | "error" | "loading";

export interface NavItem {
  id: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  badge?: "new" | "alert";     // visual callout on item
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  collapsible?: boolean;
}

export interface TidyButtonState {
  done: boolean;
  inboxCount: number;
}

export interface SidebarProps {
  groups: NavGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onAsk?: () => void;
  onTidy?: () => void;
  tidyState?: TidyButtonState;
  sysStatus?: SystemStatus;
  sysDetail?: string;
  sysProgress?: number | null;   // 0–1
  width?: string | number;       // override default rail width
  className?: string;
}

// ── Sidebar root ──────────────────────────────────────────────────────────────

export function Sidebar({
  groups,
  activeId,
  onSelect,
  onAsk,
  onTidy,
  tidyState = { done: false, inboxCount: 0 },
  sysStatus = "ready",
  sysDetail = "model ready · 1.9 gb",
  sysProgress = null,
  width,
}: SidebarProps) {
  const bp = useBreakpoint();
  const isMobile = bp === "xs" || bp === "sm";

  const resolvedWidth = width ?? (isMobile ? "100%" : "210px");

  const root: CSSProperties = {
    width:           resolvedWidth,
    height:          "100%",
    display:         "flex",
    flexDirection:   "column",
    background:      "var(--rail-bg)",
    backdropFilter:  "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    borderRight:     "1px solid var(--line-2)",
    overflowY:       "auto",
    overflowX:       "hidden",
    padding:         `var(--sp-5) var(--sp-3) var(--sp-3)`,
    transition:      "background var(--dur-slow) var(--ease-std)",
    // Scroll indicator for long nav lists
    scrollbarWidth:  "none",
  };

  return (
    <nav
      style={root}
      aria-label="Main navigation"
    >
      {/* Navigation groups */}
      {groups.map((g) => (
        <RailGroup
          key={g.id}
          group={g}
          activeId={activeId}
          onSelect={onSelect}
        />
      ))}

      {/* Push tidy button + sys status to bottom */}
      <div style={{ flex: 1 }} />

      {onTidy && (
        <TidyButton
          done={tidyState.done}
          inboxCount={tidyState.inboxCount}
          onClick={onTidy}
        />
      )}

      {onAsk && <AskEntrypoint onClick={onAsk} />}

      <SysStatusLine
        status={sysStatus}
        detail={sysDetail}
        progress={sysProgress}
      />
    </nav>
  );
}

// ── RailGroup ─────────────────────────────────────────────────────────────────

interface RailGroupProps {
  group: NavGroup;
  activeId: string;
  onSelect: (id: string) => void;
}

function RailGroup({ group, activeId, onSelect }: RailGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  const toggle = () => {
    if (group.collapsible) setCollapsed((c) => !c);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (group.collapsible && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      style={{ marginBottom: "var(--sp-6)" }}
      role="group"
      aria-label={group.label}
    >
      {/* Group label */}
      <div
        style={{
          fontFamily:    "var(--font-mono)",
          fontSize:      "var(--text-2xs)",
          letterSpacing: "0.14em",
          color:         "var(--ink-4)",
          textTransform: "uppercase",
          marginBottom:  "var(--sp-2)",
          display:       "flex",
          alignItems:    "center",
          gap:           "var(--sp-2)",
          cursor:        group.collapsible ? "pointer" : "default",
          userSelect:    "none",
        }}
        role={group.collapsible ? "button" : undefined}
        tabIndex={group.collapsible ? 0 : undefined}
        aria-expanded={group.collapsible ? !collapsed : undefined}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        {group.label}
        <div
          style={{
            flex:       1,
            height:     1,
            background: "var(--line)",
          }}
        />
        {group.collapsible && (
          <CollapseChevron collapsed={collapsed} />
        )}
      </div>

      {/* Items */}
      {!collapsed && (
        <div
          style={{
            display:       "flex",
            flexDirection: "column",
            gap:           0,
          }}
        >
          {group.items.map((item) => (
            <RailItem
              key={item.id}
              item={item}
              active={activeId === item.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── CollapseChevron ───────────────────────────────────────────────────────────

function CollapseChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      style={{
        transform:  collapsed ? "rotate(-90deg)" : "rotate(0deg)",
        transition: "transform var(--dur-fast) var(--ease-std)",
        opacity:    0.5,
        flexShrink: 0,
      }}
      aria-hidden
    >
      <path
        d="M1 2 L4 6 L7 2"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

// ── RailItem ──────────────────────────────────────────────────────────────────

interface RailItemProps {
  item: NavItem;
  active: boolean;
  onSelect: (id: string) => void;
}

function RailItem({ item, active, onSelect }: RailItemProps) {
  const [hovered, hoverHandlers] = useHover();
  const [pressed, pressHandlers] = usePress();
  const ref = useRef<HTMLButtonElement>(null);

  const isHighlit = active || hovered;

  const buttonStyle: CSSProperties = {
    display:        "flex",
    alignItems:     "center",
    gap:            "var(--sp-2)",
    padding:        `6px var(--sp-2)`,
    width:          "100%",
    textAlign:      "left",
    border:         "none",
    borderRadius:   "var(--radius-sm)",
    background:     active ? "var(--accent-dim)" : hovered ? "var(--surface-2)" : "transparent",
    color:          active ? "var(--accent)" : hovered ? "var(--ink)" : "var(--ink-2)",
    fontSize:       "var(--text-sm)",
    cursor:         "pointer",
    position:       "relative",
    outline:        "none",
    transform:      pressed ? "scale(0.98)" : "scale(1)",
    transition:     [
      "background var(--dur-fast) var(--ease-std)",
      "color var(--dur-fast) var(--ease-std)",
      "transform var(--dur-fast) var(--ease-out)",
    ].join(", "),
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(item.id);
    }
  };

  return (
    <button
      ref={ref}
      role="menuitem"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      onKeyDown={handleKeyDown}
      style={buttonStyle}
      {...hoverHandlers}
      {...pressHandlers}
    >
      {/* Left accent bar — geometric indicator, not a glow */}
      <span
        aria-hidden
        style={{
          position:     "absolute",
          left:         -2,
          top:          6,
          bottom:       6,
          width:        2,
          borderRadius: "var(--radius-pill)",
          background:   active ? "var(--accent)" : "transparent",
          transition:   "background var(--dur-fast) var(--ease-std)",
        }}
      />

      {/* Dot indicator */}
      <span
        aria-hidden
        style={{
          width:      4,
          height:     4,
          borderRadius: "var(--radius-pill)",
          background: active ? "var(--accent)" : hovered ? "var(--ink-3)" : "transparent",
          flexShrink: 0,
          transition: "background var(--dur-fast) var(--ease-std)",
        }}
      />

      {/* Icon slot */}
      {item.icon && (
        <span
          aria-hidden
          style={{
            width:     16,
            height:    16,
            flexShrink: 0,
            display:   "flex",
            alignItems: "center",
            justifyContent: "center",
            color:     active ? "var(--accent)" : "var(--ink-3)",
          }}
        >
          {item.icon}
        </span>
      )}

      {/* Label */}
      <span style={{ flex: 1, lineHeight: "1.4" }}>{item.label}</span>

      {/* Badge — "new" or "alert" */}
      {item.badge && <ItemBadge type={item.badge} />}

      {/* Count */}
      {item.count !== undefined && (
        <span
          style={{
            fontFamily:   "var(--font-mono)",
            fontSize:     "var(--text-2xs)",
            color:        active ? "var(--accent)" : "var(--ink-4)",
            background:   active ? "var(--accent-dim)" : "var(--surface-3)",
            padding:      "1px 6px",
            borderRadius: "var(--radius-pill)",
            flexShrink:   0,
            transition:   "color var(--dur-fast) var(--ease-std), background var(--dur-fast) var(--ease-std)",
          }}
        >
          {item.count > 999 ? "999+" : item.count}
        </span>
      )}
    </button>
  );
}

// ── ItemBadge ─────────────────────────────────────────────────────────────────

function ItemBadge({ type }: { type: "new" | "alert" }) {
  const bg = type === "new" ? "var(--accent)" : "var(--color-error)";
  const label = type === "new" ? "New" : "Alert";
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        display:      "inline-block",
        width:        6,
        height:       6,
        borderRadius: "var(--radius-pill)",
        background:   bg,
        flexShrink:   0,
      }}
    />
  );
}

// ── TidyButton — the daily ritual CTA ────────────────────────────────────────

interface TidyButtonProps {
  done: boolean;
  inboxCount: number;
  onClick: () => void;
}

function TidyButton({ done, inboxCount, onClick }: TidyButtonProps) {
  const [hovered, hoverHandlers] = useHover();
  const [pressed, pressHandlers] = usePress();

  const borderColor = hovered
    ? "rgba(206,255,0,0.50)"
    : "rgba(206,255,0,0.22)";

  const bg = hovered
    ? "rgba(206,255,0,0.14)"
    : done
    ? "var(--surface-3)"
    : "var(--accent-dim)";

  return (
    <button
      onClick={onClick}
      aria-label={done ? "Already tidied today" : `Tidy ${inboxCount} inbox items`}
      style={{
        padding:        "var(--sp-3)",
        background:     bg,
        border:         `1px solid ${done ? "var(--line-2)" : borderColor}`,
        borderRadius:   "var(--radius)",
        textAlign:      "left",
        width:          "100%",
        cursor:         done ? "default" : "pointer",
        marginBottom:   "var(--sp-3)",
        position:       "relative",
        overflow:       "hidden",
        transform:      pressed && !done ? "scale(0.98)" : "scale(1)",
        boxShadow:      hovered && !done ? "var(--shadow-accent)" : "none",
        transition:     [
          "background var(--dur-base) var(--ease-std)",
          "border-color var(--dur-base) var(--ease-std)",
          "box-shadow var(--dur-base) var(--ease-std)",
          "transform var(--dur-fast) var(--ease-out)",
        ].join(", "),
      }}
      disabled={done}
      {...hoverHandlers}
      {...pressHandlers}
    >
      <div
        style={{
          fontFamily:    "var(--font-display)",
          fontWeight:    700,
          fontSize:      fluidType(14, 16),
          color:         done ? "var(--ink-3)" : "var(--accent)",
          marginBottom:  done ? 0 : "var(--sp-1)",
          letterSpacing: "-0.01em",
        }}
      >
        {done ? "tidied today." : "a quiet tidy"}
      </div>

      {!done && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize:   "var(--text-2xs)",
            color:      "var(--ink-3)",
            letterSpacing: "0.04em",
          }}
        >
          {inboxCount > 0
            ? `place ${inboxCount} · suggest archives`
            : "no inbox items"}
        </div>
      )}

      {/* Decorative geometric mark — top-right corner accent */}
      {!done && (
        <span
          aria-hidden
          style={{
            position:   "absolute",
            top:        -4,
            right:      -4,
            width:      24,
            height:     24,
            borderLeft: "1px solid rgba(206,255,0,0.18)",
            borderBottom: "1px solid rgba(206,255,0,0.18)",
            opacity:    hovered ? 1 : 0.4,
            transition: "opacity var(--dur-base) var(--ease-std)",
          }}
        />
      )}
    </button>
  );
}

// ── AskEntrypoint ─────────────────────────────────────────────────────────────

function AskEntrypoint({ onClick }: { onClick: () => void }) {
  const [hovered, hoverHandlers] = useHover();
  const [pressed, pressHandlers] = usePress();

  return (
    <button
      onClick={onClick}
      aria-label="Ask AI (⌘K)"
      style={{
        display:       "flex",
        alignItems:    "center",
        gap:           "var(--sp-2)",
        padding:       "var(--sp-2) var(--sp-2)",
        width:         "100%",
        border:        "none",
        background:    "transparent",
        borderRadius:  "var(--radius-sm)",
        fontSize:      "var(--text-sm)",
        color:         hovered ? "var(--ink)" : "var(--ink-3)",
        cursor:        "pointer",
        marginBottom:  "var(--sp-3)",
        transform:     pressed ? "scale(0.98)" : "scale(1)",
        transition:    [
          "color var(--dur-fast) var(--ease-std)",
          "transform var(--dur-fast) var(--ease-out)",
        ].join(", "),
      }}
      {...hoverHandlers}
      {...pressHandlers}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize:   "var(--text-xs)",
          color:      hovered ? "var(--accent)" : "var(--ink-4)",
          transition: "color var(--dur-fast) var(--ease-std)",
        }}
        aria-hidden
      >
        &gt;_
      </span>
      <span style={{ flex: 1 }}>ask anything</span>
      <span
        style={{
          fontFamily:   "var(--font-mono)",
          fontSize:     "var(--text-2xs)",
          color:        "var(--ink-4)",
          padding:      "1px 5px",
          border:       "1px solid var(--line)",
          borderRadius: "var(--radius-xs)",
        }}
      >
        ⌘K
      </span>
    </button>
  );
}

// ── SysStatusLine ─────────────────────────────────────────────────────────────

interface SysStatusLineProps {
  status: SystemStatus;
  detail: string;
  progress: number | null;
}

function SysStatusLine({ status, detail, progress }: SysStatusLineProps) {
  const ledColor: Record<SystemStatus, string> = {
    ready:   "var(--color-success)",
    active:  "var(--accent)",
    error:   "var(--color-error)",
    loading: "var(--color-info)",
  };

  const ledAnim: Record<SystemStatus, string | undefined> = {
    ready:   undefined,
    active:  "dot-breathe 1.5s ease-in-out infinite",
    error:   undefined,
    loading: "dot-breathe 1.5s ease-in-out infinite",
  };

  return (
    <div
      style={{
        paddingTop:  "var(--sp-3)",
        borderTop:   "1px solid var(--line)",
      }}
      role="status"
      aria-live="polite"
      aria-label={`System: ${status}. ${detail}`}
    >
      {/* Progress bar — only visible during loading/active states */}
      {progress !== null && (
        <div
          style={{
            height:       1,
            background:   "var(--line)",
            marginBottom: "var(--sp-2)",
            position:     "relative",
          }}
          aria-hidden
        >
          <div
            style={{
              position:   "absolute",
              left:       0,
              top:        0,
              height:     "100%",
              width:      `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`,
              background: "var(--accent)",
              transition: "width 400ms linear",
            }}
          />
        </div>
      )}

      <div
        style={{
          display:    "flex",
          alignItems: "center",
          gap:        "var(--sp-2)",
        }}
      >
        {/* LED indicator */}
        <span
          aria-hidden
          style={{
            display:      "block",
            width:        5,
            height:       5,
            borderRadius: "var(--radius-pill)",
            background:   ledColor[status],
            flexShrink:   0,
            animation:    ledAnim[status],
          }}
        />

        <span
          style={{
            fontFamily:    "var(--font-mono)",
            fontSize:      "var(--text-2xs)",
            color:         "var(--ink-4)",
            letterSpacing: "0.04em",
            lineHeight:    1.6,
            overflow:      "hidden",
            textOverflow:  "ellipsis",
            whiteSpace:    "nowrap",
          }}
        >
          {detail}
        </span>
      </div>
    </div>
  );
}

// ── Convenience factory for building nav groups ───────────────────────────────

export function buildNavGroups(
  spaces: NavItem[],
  shelves: NavItem[],
  inbox: NavItem[]
): NavGroup[] {
  return [
    { id: "spaces",  label: "spaces",  items: spaces,  collapsible: false },
    { id: "shelves", label: "shelves", items: shelves, collapsible: true  },
    { id: "inbox",   label: "inbox",   items: inbox,   collapsible: false },
  ];
}

export { RailGroup, RailItem, SysStatusLine, TidyButton };
