// Shared UI primitives — file glyph, hairline panels, key chord badges.
// Drawn deliberately tiny so they read as type, not iconography.

const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;

// File glyph — a small label that reads as type by typography, not color.
function FileGlyph({ ext, size = 36 }) {
  const t = (FILE_TYPES[ext] || FILE_TYPES.md);
  const w = size * 0.78;
  const h = size;
  return (
    <div style={{
      width: w, height: h,
      background: 'var(--surface-2)',
      border: '1px solid var(--hairline)',
      position: 'relative',
      flex: 'none',
      borderTopRightRadius: 0,
    }}>
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: size * 0.22, height: size * 0.22,
        background: 'var(--paper-deep)',
        borderLeft: '1px solid var(--hairline)',
        borderBottom: '1px solid var(--hairline)',
      }} />
      <div style={{
        position: 'absolute',
        bottom: 4, left: 4, right: 4,
        fontFamily: "'Geist Mono', monospace",
        fontSize: Math.max(8, size * 0.22),
        color: 'var(--ink-3)',
        letterSpacing: '0.06em',
      }}>{t.label}</div>
    </div>
  );
}

// Tiny inline ext-tag, used in lists.
function ExtTag({ ext }) {
  return <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'lowercase' }}>{(FILE_TYPES[ext]||FILE_TYPES.md).label}</span>;
}

// Keyboard chord.
function Chord({ keys }) {
  return (
    <span className="mono" style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize: 11, color: 'var(--ink-3)' }}>
      {keys.map((k, i) => (
        <span key={i} style={{
          padding: '1px 5px',
          border: '1px solid var(--hairline)',
          background: 'var(--surface)',
          borderRadius: 2,
          minWidth: 14, textAlign: 'center'
        }}>{k}</span>
      ))}
    </span>
  );
}

function Caret({ dir = 'right', size = 10 }) {
  const r = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" style={{ transform: `rotate(${r}deg)`, opacity: 0.6 }}>
      <path d="M3 1 L7 5 L3 9" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="square" />
    </svg>
  );
}

function Plus({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12">
      <path d="M6 1 V11 M1 6 H11" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

// Confidence bar — vermillion fill, 2px, animated. Color shifts with confidence level.
function ConfidenceBar({ value, width = 64, showLabel = false }) {
  const pct = Math.min(100, Math.max(0, (value || 0) * 100));
  const color = pct >= 70 ? 'var(--accent)' : pct >= 50 ? 'var(--accent-soft)' : 'var(--ink-4)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width, height: 2, background: 'var(--hairline)', position: 'relative', borderRadius: 1 }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${pct}%`,
          background: color,
          borderRadius: 1,
          transition: 'width 700ms cubic-bezier(.22,.61,.36,1)',
        }} />
      </div>
      {showLabel && (
        <span className="mono" style={{ fontSize: 9, color: 'var(--ink-4)', letterSpacing: '0.04em', minWidth: 22 }}>
          {Math.round(pct)}
        </span>
      )}
    </div>
  );
}

// Circuit trace background — place inside a position:relative container.
// Renders a faint PCB-style geometric pattern at the hairline color level.
function CircuitBg({ opacity = 0.3 }) {
  const id = useMemo(() => 'ckt-' + Math.random().toString(36).slice(2), []);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', opacity }}>
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id={id} x="0" y="0" width="56" height="56" patternUnits="userSpaceOnUse">
            {/* horizontal traces */}
            <line x1="0" y1="14" x2="56" y2="14" stroke="rgba(27,24,19,0.22)" strokeWidth="0.6"/>
            <line x1="0" y1="42" x2="56" y2="42" stroke="rgba(27,24,19,0.14)" strokeWidth="0.6"/>
            {/* vertical traces */}
            <line x1="18" y1="0" x2="18" y2="56" stroke="rgba(27,24,19,0.18)" strokeWidth="0.6"/>
            <line x1="46" y1="0" x2="46" y2="56" stroke="rgba(27,24,19,0.11)" strokeWidth="0.6"/>
            {/* L-bend connectors */}
            <polyline points="18,14 18,28 46,28" fill="none" stroke="rgba(27,24,19,0.14)" strokeWidth="0.6"/>
            <polyline points="46,42 46,28" fill="none" stroke="rgba(27,24,19,0.10)" strokeWidth="0.6"/>
            {/* solder pads */}
            <circle cx="18" cy="14" r="2" fill="rgba(27,24,19,0.22)"/>
            <circle cx="46" cy="42" r="2" fill="rgba(27,24,19,0.18)"/>
            <circle cx="18" cy="42" r="1.2" fill="rgba(27,24,19,0.14)"/>
            <circle cx="46" cy="14" r="1.2" fill="rgba(27,24,19,0.12)"/>
            <circle cx="46" cy="28" r="1.5" fill="rgba(178,58,31,0.12)"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`}/>
      </svg>
    </div>
  );
}

// Live data readout pill — shown in top bar and rail during AI activity.
function DataPill({ label, active = false }) {
  return (
    <div className="data-pill">
      {active && <div className="data-pill-dot" />}
      {!active && <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--ink-4)', flex: 'none' }} />}
      <span>{label}</span>
    </div>
  );
}

// System status line — sits at the bottom of the side rail.
function SysLine({ status = 'ready', detail = 'model ready · 1.9gb', progress = null }) {
  const dotClass = status === 'ready' ? 'sys-dot ready' : status === 'loading' ? 'sys-dot loading' : 'sys-dot offline';
  return (
    <div>
      {progress !== null && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ height: 1, background: 'var(--hairline)', position: 'relative' }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, height: '100%',
              width: `${Math.round(progress * 100)}%`,
              background: 'var(--accent)',
              transition: 'width 400ms linear',
            }} />
          </div>
        </div>
      )}
      <div className="sys-line">
        <div className={dotClass} />
        <span>{detail}</span>
      </div>
    </div>
  );
}

// Section header.
function SectionHead({ title, sub, right, anchor }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, paddingBottom: 14, borderBottom: '1px solid var(--hairline)' }}>
      {anchor != null && (
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', minWidth: 22, letterSpacing: '0.08em' }}>
          {String(anchor).padStart(2, '0')}
        </span>
      )}
      <h2 className="serif-i" style={{ margin: 0, fontSize: 26, fontWeight: 400, color: 'var(--ink)', lineHeight: 1.1 }}>{title}</h2>
      {sub && <span className="quiet" style={{ fontSize: 12 }}>{sub}</span>}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

// Pill button.
function PillBtn({ children, primary, onClick, onMouseEnter, onMouseLeave, style, title }) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={title}
      className="t-fast"
      style={{
        padding: '7px 14px',
        fontSize: 13,
        letterSpacing: '0.005em',
        color: primary ? 'var(--surface-2)' : 'var(--ink)',
        background: primary ? 'var(--ink)' : 'transparent',
        border: '1px solid ' + (primary ? 'var(--ink)' : 'var(--hairline)'),
        borderRadius: 999,
        cursor: 'pointer',
        ...style,
      }}
      onPointerDown={(e)=>{ e.currentTarget.style.transform = 'scale(0.98)'; }}
      onPointerUp={(e)=>{ e.currentTarget.style.transform = 'none'; }}
    >{children}</button>
  );
}

function TextLink({ children, onClick, color = 'var(--ink)' }) {
  return (
    <button onClick={onClick} className="t-fast" style={{
      color, fontSize: 13, padding: 0, borderBottom: '1px solid transparent', cursor: 'pointer'
    }}
    onMouseEnter={e=>{e.currentTarget.style.borderBottomColor='var(--hairline)';}}
    onMouseLeave={e=>{e.currentTarget.style.borderBottomColor='transparent';}}
    >{children}</button>
  );
}

const VDiv = ({ h = 14 }) => <div style={{ width: 1, height: h, background: 'var(--hairline)' }} />;

// HankoMark — the seal. Accepts a `pulse` prop to activate the learner glow.
function HankoMark({ children = '〇', size = 22, color = 'var(--accent)', pulse = false }) {
  return (
    <span
      className={pulse ? 'hanko-active' : ''}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size,
        border: '1px solid ' + color,
        borderRadius: '50%',
        color,
        fontSize: size * 0.55,
        lineHeight: 1,
        flex: 'none',
        transition: 'border-color 400ms ease',
      }}>{children}</span>
  );
}

Object.assign(window, {
  FileGlyph, ExtTag, Chord, Caret, Plus,
  ConfidenceBar, CircuitBg, DataPill, SysLine,
  SectionHead, PillBtn, TextLink, VDiv, HankoMark,
});
