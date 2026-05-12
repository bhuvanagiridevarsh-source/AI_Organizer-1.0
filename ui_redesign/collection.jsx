// Collection detail view — drill into a single collection.
// Long-form list, with a quiet header. The "place for everything" rule:
// every file is in exactly one collection; we display its place clearly.

const { useState: useStateC, useMemo: useMemoC } = React;

function CollectionView({ collectionId, onBack, onSelectFile }) {
  const c = COLLECTIONS.find(x => x.id === collectionId);
  const files = SAMPLE_FILES_FOR(collectionId);

  const [sort, setSort] = useStateC('updated');
  const sorted = useMemoC(() => {
    const copy = [...files];
    if (sort === 'name') copy.sort((a,b) => a.name.localeCompare(b.name));
    if (sort === 'size') copy.sort((a,b) => parseFloat(b.size) - parseFloat(a.size));
    return copy;
  }, [files, sort]);

  if (!c) return null;

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '48px 64px 96px',
      animation: 'ink-wash 320ms ease both',
    }}>
      {/* breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36 }}>
        <button onClick={onBack} className="mono quiet t-fast" style={{ fontSize: 11, letterSpacing: '0.08em' }}
          onMouseEnter={e=>{e.currentTarget.style.color='var(--ink)';}}
          onMouseLeave={e=>{e.currentTarget.style.color='';}}
        >← library</button>
        <span className="quiet">·</span>
        <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em' }}>collection</span>
      </div>

      {/* hero */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 48, paddingBottom: 36, borderBottom: '1px solid var(--hairline)', marginBottom: 36 }}>
        <div style={{ flex: 1 }}>
          <h1 className="serif-i" style={{
            margin: 0,
            fontSize: 72,
            fontWeight: 400,
            lineHeight: 1.0,
            letterSpacing: '-0.02em',
            marginBottom: 18,
          }}>{c.title}</h1>
          <div style={{ fontSize: 16, color: 'var(--ink-2)', maxWidth: 560, lineHeight: 1.5 }}>{c.sub}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 14, minWidth: 180 }}>
          <Stat label="files" value={String(c.count)} />
          <Stat label="updated" value={c.updated} />
          <Stat label="kept since" value="march, 2024" />
        </div>
      </div>

      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 18 }}>
        <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>sort</span>
        {['updated','name','size'].map(s => (
          <button key={s} onClick={() => setSort(s)} className="t-fast" style={{
            fontSize: 13,
            color: sort === s ? 'var(--ink)' : 'var(--ink-3)',
            borderBottom: '1px solid ' + (sort === s ? 'var(--ink)' : 'transparent'),
            paddingBottom: 2,
          }}>{s}</button>
        ))}
        <div style={{ flex: 1 }} />
        <TextLink>add files</TextLink>
        <VDiv />
        <TextLink>standardize names</TextLink>
      </div>

      {/* file list */}
      <div>
        {sorted.map((f, i) => (
          <FileRow key={f.id} f={f} onClick={() => onSelectFile({ ...f, collection: c.id })} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="mono quiet" style={{ fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div className="serif-i" style={{ fontSize: 22, color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

function FileRow({ f, onClick }) {
  const [hover, setHover] = useStateC(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      className="t-fast"
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 24px 1fr 120px 100px 80px',
        alignItems: 'center',
        gap: 18,
        padding: '14px 4px',
        borderBottom: '1px solid var(--hairline-2)',
        cursor: 'pointer',
        background: hover ? 'rgba(27,24,19,0.02)' : 'transparent',
      }}
    >
      <span className="seal" style={{ background: f.pinned ? 'var(--accent)' : 'transparent', border: f.pinned ? 'none' : '1px solid transparent' }} />
      <ExtTag ext={f.ext} />
      <div style={{ fontSize: 14 }}>{f.name}</div>
      <div className="mono quiet" style={{ fontSize: 11, textAlign: 'right' }}>{f.size}</div>
      <div className="mono quiet" style={{ fontSize: 11, textAlign: 'right' }}>{f.updated}</div>
      <div className="t-fast" style={{ opacity: hover ? 1 : 0, fontSize: 12, textAlign: 'right' }}>open</div>
    </div>
  );
}

// ─── Right-side inspector for a selected file ───────────────────────────────
function FileInspector({ file, onClose }) {
  if (!file) return null;
  return (
    <div className="t" style={{
      width: 360, flex: 'none',
      borderLeft: '1px solid var(--hairline)',
      background: 'var(--surface)',
      display: 'flex', flexDirection: 'column',
      animation: 'fade-in 240ms ease both',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid var(--hairline)' }}>
        <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>file</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} className="quiet" style={{ fontSize: 13 }}>close</button>
      </div>
      <div style={{ padding: '28px 24px', overflowY: 'auto' }}>
        <FileGlyph ext={file.ext} size={64} />
        <h3 className="serif-i" style={{ margin: '20px 0 6px', fontSize: 26, fontWeight: 400, lineHeight: 1.15 }}>
          {file.name}
        </h3>
        <div className="quiet" style={{ fontSize: 12, marginBottom: 24 }}>
          {(FILE_TYPES[file.ext]||FILE_TYPES.md).label} · {file.size || '—'} · {file.updated || file.opened || '—'}
        </div>

        <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 18, marginBottom: 18 }}>
          <Meta label="lives in" value={collTitle(file.collection) || '—'} serif />
          <Meta label="tags" value="quiet · attention · winter" />
          <Meta label="placed by" value="library, automatically" />
          <Meta label="last opened" value={file.opened || '8 days ago'} />
        </div>

        <div className="serif-i" style={{ fontSize: 16, color: 'var(--ink-2)', lineHeight: 1.5, paddingTop: 16, borderTop: '1px solid var(--hairline)' }}>
          “Attention is the rarest and purest form of generosity.” — a line you underlined twice.
        </div>

        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <InspectorAction label="open" hint="↵" />
          <InspectorAction label="ask about this" />
          <InspectorAction label="move to another collection" />
          <InspectorAction label="archive" />
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value, serif }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', alignItems: 'baseline' }}>
      <span className="mono quiet" style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      <span className={serif ? 'serif-i' : ''} style={{ fontSize: serif ? 16 : 13, color: 'var(--ink)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function InspectorAction({ label, hint }) {
  const [hover, setHover] = useStateC(false);
  return (
    <button
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      className="t-fast"
      style={{
        display: 'flex', alignItems: 'center',
        padding: '12px 14px',
        textAlign: 'left',
        fontSize: 13,
        background: hover ? 'var(--surface-2)' : 'transparent',
        border: '1px solid ' + (hover ? 'var(--hairline)' : 'transparent'),
        cursor: 'pointer',
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span className="mono quiet" style={{ fontSize: 11 }}>{hint}</span>}
    </button>
  );
}

Object.assign(window, { CollectionView, FileInspector });
