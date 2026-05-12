// Main app — composes the whole desktop view: top bar, side rail, main column,
// inspector. Handles routing between home and collection views, and the ask
// overlay. State persists for the duration of the session only.

const { useState: useStateApp, useEffect: useEffectApp, useMemo: useMemoApp } = React;

// ─── Tweakable defaults (persisted by host) ─────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "vermillion",
  "density": "comfortable",
  "showSeals": true,
  "wordmark": "organize"
}/*EDITMODE-END*/;

const ACCENTS = {
  vermillion: { seal: '#B23A1F', soft: '#C56448', label: 'shu' },
  indigo:     { seal: '#2A3E5C', soft: '#4F6885', label: 'kachi' },
  moss:       { seal: '#5B6B43', soft: '#7E8E64', label: 'koke' },
  sumi:       { seal: '#1B1813', soft: '#524C42', label: 'sumi' },
};

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // route: 'home' | 'collection'
  const [view, setView] = useStateApp('home');
  const [activeCollection, setActiveCollection] = useStateApp(null);
  const [selectedFile, setSelectedFile] = useStateApp(null);
  const [askOpen, setAskOpen] = useStateApp(false);
  const [askSeed, setAskSeed] = useStateApp(null);
  const [dropping, setDropping] = useStateApp(false);
  const [activeRail, setActiveRail] = useStateApp('all');

  // Inbox & suggestions are stateful so we can place / dismiss them.
  const [inbox, setInbox] = useStateApp(INBOX);
  const [suggestions, setSuggestions] = useStateApp(SUGGESTIONS);
  const [tidied, setTidied] = useStateApp(false);
  const [now] = useStateApp({ weekday: 'wednesday', date: 'may 9, 2026' });

  // ── Tech layer state ─────────────────────────────────────
  const [learnerActive, setLearnerActive] = useStateApp(true);
  const [scanLabel, setScanLabel] = useStateApp('scanning 3 files · 412ms');
  const [sysStatus, setSysStatus] = useStateApp('ready');
  const [sysDetail, setSysDetail] = useStateApp('model ready · 1.9gb');

  // Simulate rotating scan labels for demo
  useEffectApp(() => {
    const labels = [
      'scanning 3 files · 412ms',
      'classifying · budget_q2.xlsx',
      'indexing 2 files · 871ms',
      null, null, // sometimes quiet
    ];
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % labels.length;
      setScanLabel(labels[i]);
    }, 3200);
    return () => clearInterval(iv);
  }, []);

  // Apply accent to root vars
  useEffectApp(() => {
    const a = ACCENTS[tw.accent] || ACCENTS.vermillion;
    document.documentElement.style.setProperty('--accent', a.seal);
    document.documentElement.style.setProperty('--accent-soft', a.soft);
    document.documentElement.style.setProperty('--pad', tw.density === 'compact' ? '20px' : '28px');
  }, [tw.accent, tw.density]);

  // ESC closes the ask overlay or the inspector
  useEffectApp(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (askOpen) setAskOpen(false);
        else if (selectedFile) setSelectedFile(null);
        else if (view === 'collection') setView('home');
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAskSeed(null);
        setAskOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askOpen, selectedFile, view]);

  const placeOne = (id) => setInbox(p => p.filter(x => x.id !== id));
  const dismissSuggestion = (id) => setSuggestions(p => p.filter(x => x.id !== id));
  const tidy = () => {
    setTidied(true);
    // animate by clearing inbox in a stagger
    inbox.forEach((f, i) => setTimeout(() => placeOne(f.id), 120 * i));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--paper)' }}>
      <TopBar
        wordmark={tw.wordmark}
        onAsk={() => { setAskSeed(null); setAskOpen(true); }}
        learnerActive={learnerActive}
        scanLabel={scanLabel}
      />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideRail
          active={activeRail}
          onSelect={setActiveRail}
          onAsk={() => { setAskSeed(null); setAskOpen(true); }}
          onTidy={tidy}
          inboxCount={inbox.length}
          tidied={tidied}
          sysStatus={sysStatus}
          sysDetail={sysDetail}
          sysProgress={null}
        />

        {/* main column */}
        <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
            {view === 'home' && (
              <HomeView
                now={now}
                inbox={inbox}
                suggestions={suggestions}
                tidied={tidied}
                onTidy={tidy}
                onAsk={(seed, soft) => {
                  if (soft) return; // soft focus: don't open yet
                  setAskSeed(seed || null);
                  setAskOpen(true);
                }}
                onPlace={placeOne}
                onDismissSug={dismissSuggestion}
                onOpenCollection={(c) => { setActiveCollection(c.id); setView('collection'); }}
                onSelectFile={setSelectedFile}
                dropping={dropping} setDropping={setDropping}
              />
            )}
            {view === 'collection' && (
              <CollectionView
                collectionId={activeCollection}
                onBack={() => setView('home')}
                onSelectFile={setSelectedFile}
              />
            )}
          </div>

          {selectedFile && (
            <FileInspector file={selectedFile} onClose={() => setSelectedFile(null)} />
          )}
        </div>
      </div>

      <AskOverlay open={askOpen} onClose={() => setAskOpen(false)} seed={askSeed} />

      <Tweaks tw={tw} setTweak={setTweak} />
    </div>
  );
}

// ─── Top bar — wordmark + live AI status + ask ──────────────────────────────
function TopBar({ wordmark, onAsk, learnerActive, scanLabel }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 18,
      padding: '14px 28px',
      borderBottom: '1px solid var(--hairline)',
      flex: 'none',
      background: 'var(--paper)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <HankoMark size={20} pulse={learnerActive} />
        <span className="serif-i" style={{ fontSize: 22, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{wordmark}</span>
      </div>
      <VDiv h={16} />
      <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em' }}>library · 718 files · 6 collections</span>

      {/* live AI activity readout */}
      {scanLabel && (
        <>
          <VDiv h={12} />
          <DataPill label={scanLabel} active={true} />
        </>
      )}

      <div style={{ flex: 1 }} />

      <button onClick={onAsk} className="t-fast" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 12px',
        border: '1px solid var(--hairline)',
        background: 'var(--surface)',
        borderRadius: 999,
        fontSize: 12,
        color: 'var(--ink-2)',
      }}
      onMouseEnter={e=>{e.currentTarget.style.background='var(--surface-2)';}}
      onMouseLeave={e=>{e.currentTarget.style.background='var(--surface)';}}
      >
        <span className="serif-i">ask</span>
        <Chord keys={['⌘','K']} />
      </button>

      <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.06em' }}>v 0.1 · 2026</span>
    </div>
  );
}

// ─── Side rail — the place for everything ───────────────────────────────────
function SideRail({ active, onSelect, onAsk, onTidy, inboxCount, tidied, sysStatus, sysDetail, sysProgress }) {
  const spaces = [
    { id: 'all',      label: 'everything', count: 718 },
    { id: 'work',     label: 'work',       count: 312 },
    { id: 'personal', label: 'personal',   count: 287 },
    { id: 'archive',  label: 'archive',    count: 119 },
  ];
  const shelves = [
    { id: 'docs',  label: 'documents' },
    { id: 'imgs',  label: 'images' },
    { id: 'audio', label: 'audio & voice' },
    { id: 'code',  label: 'code' },
    { id: 'links', label: 'web' },
  ];

  return (
    <div style={{
      width: 'var(--rail)',
      flex: 'none',
      borderRight: '1px solid var(--hairline)',
      padding: '28px 22px',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
    }}>
      <RailGroup label="spaces">
        {spaces.map(s => (
          <RailItem key={s.id} active={active === s.id} onClick={() => onSelect(s.id)}>
            <span style={{ flex: 1 }}>{s.label}</span>
            <span className="mono quiet" style={{ fontSize: 10 }}>{s.count}</span>
          </RailItem>
        ))}
      </RailGroup>

      <RailGroup label="shelves">
        {shelves.map(s => (
          <RailItem key={s.id} active={active === s.id} onClick={() => onSelect(s.id)}>
            <span style={{ flex: 1 }}>{s.label}</span>
          </RailItem>
        ))}
      </RailGroup>

      <RailGroup label="inbox">
        <RailItem active={active === 'inbox'} onClick={() => onSelect('inbox')}>
          <span style={{ flex: 1 }}>awaiting placement</span>
          <span className="mono" style={{
            fontSize: 10,
            color: inboxCount > 0 && !tidied ? 'var(--accent)' : 'var(--ink-3)',
          }}>{inboxCount}</span>
        </RailItem>
      </RailGroup>

      <div style={{ flex: 1 }} />

      {/* the daily ritual button — quiet but always present */}
      <button onClick={onTidy} className="t-fast" style={{
        marginTop: 24,
        padding: '14px 16px',
        background: 'var(--surface-2)',
        border: '1px solid var(--hairline)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
      onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--ink-3)';}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--hairline)';}}
      >
        <div className="serif-i" style={{ fontSize: 18, color: 'var(--ink)', marginBottom: 4 }}>
          {tidied ? 'tidied today.' : 'a quiet tidy'}
        </div>
        <div className="quiet" style={{ fontSize: 11 }}>
          {tidied ? 'tomorrow morning, again.' : 'place inbox · suggest archives'}
        </div>
      </button>

      {/* sys status — model health at a glance */}
      <SysLine status={sysStatus || 'ready'} detail={sysDetail || 'model ready · 1.9gb'} progress={sysProgress} />
    </div>
  );
}

function RailGroup({ label, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="mono quiet" style={{ fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>{children}</div>
    </div>
  );
}

function RailItem({ children, active, onClick }) {
  const [hover, setHover] = useStateApp(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      className="t-fast"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 4px',
        fontSize: 13,
        color: active ? 'var(--ink)' : (hover ? 'var(--ink)' : 'var(--ink-2)'),
        cursor: 'pointer',
        position: 'relative',
        textAlign: 'left',
      }}
    >
      <span className="t-fast" style={{
        width: 4, height: 4, borderRadius: '50%',
        background: active ? 'var(--accent)' : 'transparent',
        flex: 'none',
      }} />
      {children}
    </button>
  );
}

// ─── Home view composer ─────────────────────────────────────────────────────
function HomeView({ now, inbox, suggestions, tidied, onTidy, onAsk, onPlace, onDismissSug, onOpenCollection, onSelectFile, dropping, setDropping }) {
  return (
    <div style={{ padding: '48px 64px 96px', maxWidth: 1280, margin: '0 auto' }}>
      <LibraryHeader now={now} onTidy={onTidy} />
      <AskBar onOpen={onAsk} onDrop={() => {/* simulated */}} dropping={dropping} setDropping={setDropping} />

      {!tidied && inbox.length > 0 && (
        <InboxRow items={inbox} onPlace={onPlace} onSelect={onSelectFile} />
      )}

      <CollectionsGrid items={COLLECTIONS} onOpen={onOpenCollection} />

      <RecentList items={RECENT} onSelect={onSelectFile} />

      {suggestions.length > 0 && (
        <Suggestions items={suggestions} onDismiss={onDismissSug} />
      )}

      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <div style={{
      paddingTop: 32, marginTop: 64,
      borderTop: '1px solid var(--hairline)',
      display: 'flex', alignItems: 'center', gap: 18,
    }}>
      <span className="serif-i quiet" style={{ fontSize: 14 }}>everything in its place.</span>
      <div style={{ flex: 1 }} />
      <span className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em' }}>last reviewed · 14 minutes ago</span>
    </div>
  );
}

// ─── Tweaks panel ───────────────────────────────────────────────────────────
function Tweaks({ tw, setTweak }) {
  const accentOptions = Object.keys(ACCENTS).map(k => ACCENTS[k].seal);
  const accentByColor = Object.fromEntries(Object.entries(ACCENTS).map(([k,v])=>[v.seal,k]));
  return (
    <TweaksPanel title="tweaks">
      <TweakSection label="accent" />
      <TweakColor
        label="seal"
        value={ACCENTS[tw.accent]?.seal || ACCENTS.vermillion.seal}
        options={accentOptions}
        onChange={(c) => setTweak('accent', accentByColor[c] || 'vermillion')}
      />
      <TweakSection label="layout" />
      <TweakRadio
        label="density"
        value={tw.density}
        options={['comfortable','compact']}
        onChange={(v)=>setTweak('density', v)}
      />
      <TweakText
        label="wordmark"
        value={tw.wordmark}
        onChange={(v)=>setTweak('wordmark', v)}
      />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
