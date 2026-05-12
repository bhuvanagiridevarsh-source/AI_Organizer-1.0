// Library — the main home view. The first impression of the app.
//
// Hidden rules at work here:
//  · only what's needed right now is on the page
//  · everything has a place, and the place is predictable
//  · the surface is paper-clean — no chrome, no glow
//  · rhythm comes from a single hairline rule and a single type scale
//  · the eye has a primary point of focus, not three competing ones

const { useState: useStateL, useEffect: useEffectL, useRef: useRefL, useMemo: useMemoL } = React;

// ─── Header inside the library main column ──────────────────────────────────
function LibraryHeader({ now, onTidy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, marginBottom: 36 }}>
      <div style={{ flex: 1 }}>
        <div className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }}>
          {now.weekday}, {now.date}
        </div>
        <h1 className="serif-i" style={{
          margin: 0, fontSize: 56, fontWeight: 400,
          lineHeight: 1.05, letterSpacing: '-0.015em',
          color: 'var(--ink)',
          maxWidth: 760,
        }}>
          twelve files arrived since monday.
          <span className="quiet"> shall I tidy?</span>
        </h1>
      </div>
      <div style={{ display: 'flex', gap: 10, paddingBottom: 6 }}>
        <PillBtn onClick={onTidy} primary>tidy now</PillBtn>
        <PillBtn>review later</PillBtn>
      </div>
    </div>
  );
}

// ─── The ask bar — the second-most-important element after the headline ─────
function AskBar({ onOpen, onDrop, dropping, setDropping }) {
  const [val, setVal] = useStateL('');
  const [focused, setFocused] = useStateL(false);
  const inputRef = useRefL();

  const submit = () => {
    if (val.trim()) onOpen(val);
    else onOpen();
  };

  return (
    <div
      onDragOver={(e)=>{ e.preventDefault(); setDropping(true); }}
      onDragLeave={()=>setDropping(false)}
      onDrop={(e)=>{ e.preventDefault(); setDropping(false); onDrop(); }}
      className="t"
      style={{
        position: 'relative',
        background: dropping ? 'var(--surface-2)' : 'var(--surface)',
        border: '1px solid ' + (dropping ? 'var(--accent)' : (focused ? 'rgba(27,24,19,0.2)' : 'var(--hairline)')),
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        marginBottom: 56,
        // scanline texture appears on focus
        backgroundImage: focused
          ? 'repeating-linear-gradient(0deg, transparent 0px, transparent 3px, rgba(27,24,19,0.016) 3px, rgba(27,24,19,0.016) 4px)'
          : 'none',
      }}
    >
      {/* terminal prompt marker */}
      <span className="mono" style={{
        fontSize: 14,
        color: focused ? 'var(--accent)' : 'var(--ink-4)',
        flex: 'none',
        transition: 'color 200ms ease',
        letterSpacing: 0,
      }}>{'›'}</span>
      <input
        ref={inputRef}
        value={val}
        onChange={e=>setVal(e.target.value)}
        onKeyDown={e=>{ if (e.key === 'Enter') submit(); }}
        onFocus={()=>{ setFocused(true); onOpen(val || null, /*soft*/ true); }}
        onBlur={()=>setFocused(false)}
        placeholder="what did i write about attention this winter?"
        style={{
          flex: 1,
          fontSize: 18,
          fontFamily: focused ? "'Geist Mono', monospace" : 'inherit',
          color: 'var(--ink)',
          transition: 'font-family 150ms ease',
          letterSpacing: focused ? '-0.01em' : '0.005em',
        }}
      />
      <span className="quiet mono" style={{ fontSize: 11, letterSpacing: '0.06em' }}>or drop a file</span>
      <Chord keys={['⌘','K']} />
    </div>
  );
}

// ─── Inbox row — small file plates, AI's guess written underneath ───────────
function InboxRow({ items, onPlace, onSelect }) {
  return (
    <div style={{ marginBottom: 64 }}>
      <SectionHead
        anchor={1}
        title="inbox"
        sub={`${items.length} awaiting placement`}
        right={
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <TextLink onClick={() => items.forEach(i => onPlace(i.id))}>place all where suggested</TextLink>
          </div>
        }
      />
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, minmax(0,1fr))',
        gap: 18,
        paddingTop: 22,
      }}>
        {items.slice(0, 6).map((f, i) => (
          <InboxCard key={f.id} f={f} onPlace={() => onPlace(f.id)} onSelect={() => onSelect(f)} delay={i * 35} />
        ))}
      </div>
    </div>
  );
}

function InboxCard({ f, onPlace, onSelect, delay }) {
  const [hover, setHover] = useStateL(false);
  return (
    <div
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      onClick={onSelect}
      className="t-fast"
      style={{
        padding: 14,
        background: hover ? 'var(--surface-2)' : 'transparent',
        border: '1px solid ' + (hover ? 'var(--hairline)' : 'transparent'),
        cursor: 'pointer',
        animation: `fade-up 380ms ${delay}ms cubic-bezier(.22,.61,.36,1) both`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <FileGlyph ext={f.ext} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 13,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{f.name}</div>
          <div className="mono quiet" style={{ fontSize: 10, marginTop: 4, letterSpacing: '0.06em' }}>
            {(FILE_TYPES[f.ext]||FILE_TYPES.md).label}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 6 }}>
        <ConfidenceBar value={f.confidence} width={56} showLabel={true} />
      </div>
      <div className="serif-i" style={{ fontSize: 16, color: 'var(--ink-2)', lineHeight: 1.2 }}>
        → {f.guess}
      </div>

      <div className="t-fast" style={{
        marginTop: 14,
        display: 'flex', gap: 10,
        opacity: hover ? 1 : 0,
        transform: hover ? 'translateY(0)' : 'translateY(4px)',
      }}>
        <button onClick={(e)=>{ e.stopPropagation(); onPlace(); }} className="mono" style={{
          fontSize: 11, color: 'var(--ink)', borderBottom: '1px solid var(--hairline)', paddingBottom: 1,
        }}>accept</button>
        <button onClick={(e)=>e.stopPropagation()} className="mono quiet" style={{
          fontSize: 11, borderBottom: '1px solid transparent', paddingBottom: 1,
        }}>change</button>
      </div>
    </div>
  );
}

// ─── Recent — last things you touched, single-line list ─────────────────────
function RecentList({ items, onSelect }) {
  return (
    <div style={{ marginBottom: 64 }}>
      <SectionHead anchor={2} title="recent" sub="last things you touched" />
      <div style={{ paddingTop: 8 }}>
        {items.map((f, i) => (
          <RecentRow key={f.id} f={f} onClick={() => onSelect(f)} />
        ))}
      </div>
    </div>
  );
}

function RecentRow({ f, onClick }) {
  const [hover, setHover] = useStateL(false);
  return (
    <div
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      onClick={onClick}
      className="t-fast"
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 1fr 220px 80px 80px',
        alignItems: 'center',
        gap: 24,
        padding: '14px 4px',
        borderBottom: '1px solid var(--hairline-2)',
        cursor: 'pointer',
        background: hover ? 'rgba(27,24,19,0.02)' : 'transparent',
      }}
    >
      <ExtTag ext={f.ext} />
      <div style={{ fontSize: 14, color: 'var(--ink)' }}>{f.name}</div>
      <div className="serif-i" style={{ fontSize: 14, color: 'var(--ink-2)' }}>{collTitle(f.collection)}</div>
      <div className="mono quiet" style={{ fontSize: 11, textAlign: 'right' }}>{f.size}</div>
      <div className="mono quiet" style={{ fontSize: 11, textAlign: 'right' }}>{f.opened}</div>
    </div>
  );
}

const collTitle = (id) => (COLLECTIONS.find(c => c.id === id)?.title || id);

// ─── Collections grid — asymmetric, two columns, two sizes ──────────────────
function CollectionsGrid({ items, onOpen }) {
  return (
    <div style={{ marginBottom: 80 }}>
      <SectionHead
        anchor={3}
        title="collections"
        sub={`${items.length}, sorted as you keep them`}
        right={<TextLink>edit order</TextLink>}
      />
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 1fr',
        gap: 24,
        paddingTop: 28,
      }}>
        {items.map((c, i) => (
          <CollectionCard key={c.id} c={c} large={i < 2} onOpen={() => onOpen(c)} delay={i * 50} />
        ))}
      </div>
    </div>
  );
}

function CollectionCard({ c, large, onOpen, delay }) {
  const [hover, setHover] = useStateL(false);
  const isIndigo = c.hue === 'indigo';
  const isSand   = c.hue === 'sand';

  const bg = isIndigo ? 'var(--ink)' : (isSand ? 'var(--paper-deep)' : 'var(--surface-2)');
  const fg = isIndigo ? 'var(--surface-2)' : 'var(--ink)';
  const fg2 = isIndigo ? 'rgba(248,245,236,0.55)' : 'var(--ink-3)';

  return (
    <button
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      onClick={onOpen}
      className="t"
      style={{
        textAlign: 'left',
        padding: large ? '36px 36px 32px' : '28px 28px 24px',
        minHeight: large ? 220 : 170,
        background: bg,
        color: fg,
        border: isIndigo ? '1px solid var(--ink)' : '1px solid var(--hairline)',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'pointer',
        animation: `fade-up 460ms ${delay}ms cubic-bezier(.22,.61,.36,1) both`,
        transform: hover ? 'translateY(-2px)' : 'none',
      }}
    >
      {/* circuit trace background — the machine underneath the paper */}
      <CircuitBg opacity={isIndigo ? 0.12 : 0.22} />

      {/* pin / hanko */}
      {c.pinned && !isIndigo && (
        <div style={{ position: 'absolute', top: 18, right: 18 }}>
          <HankoMark />
        </div>
      )}
      {c.pinned && isIndigo && (
        <div style={{ position: 'absolute', top: 18, right: 18 }}>
          <HankoMark color="var(--surface-2)" />
        </div>
      )}

      <div className="mono" style={{ fontSize: 11, letterSpacing: '0.10em', color: fg2, marginBottom: large ? 32 : 22 }}>
        {String(c.count).padStart(3, '0')} files · updated {c.updated}
      </div>

      <h3 className="serif-i" style={{
        margin: 0,
        fontSize: large ? 38 : 28,
        fontWeight: 400,
        lineHeight: 1.05,
        letterSpacing: '-0.01em',
        color: fg,
        marginBottom: 12,
      }}>{c.title}</h3>

      <div style={{ fontSize: 13, color: fg2, maxWidth: 460, lineHeight: 1.45 }}>
        {c.sub}
      </div>

      {/* corner reveal */}
      <div className="t-fast" style={{
        position: 'absolute', bottom: 18, right: 18,
        display: 'flex', gap: 10, alignItems: 'center',
        color: fg2,
        opacity: hover ? 1 : 0.4,
      }}>
        <span className="serif-i" style={{ fontSize: 14 }}>open</span>
        <Caret />
      </div>
    </button>
  );
}

// ─── A quiet suggestions strip — Seiri / Seiketsu without naming them ───────
function Suggestions({ items, onDismiss }) {
  return (
    <div style={{ marginBottom: 64 }}>
      <SectionHead anchor={4} title="quiet suggestions" sub="three things i noticed" />
      <div style={{ paddingTop: 12 }}>
        {items.map(s => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 18,
            padding: '18px 4px',
            borderBottom: '1px solid var(--hairline-2)',
          }}>
            <span className="seal" style={{ background: 'var(--ink-3)' }} />
            <div className="serif-i" style={{ fontSize: 18, color: 'var(--ink)', flex: 1 }}>{s.title}</div>
            <button className="mono" style={{ fontSize: 11, color: 'var(--ink)', borderBottom: '1px solid var(--hairline)', paddingBottom: 2 }}>show me</button>
            <button onClick={() => onDismiss(s.id)} className="mono quiet" style={{ fontSize: 11, paddingBottom: 2 }}>not now</button>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LibraryHeader, AskBar, InboxRow, RecentList, CollectionsGrid, Suggestions, collTitle });
