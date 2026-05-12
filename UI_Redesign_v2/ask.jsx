// Ask overlay — chat with your library. Slides up from below the ask bar
// in the home view. Calm by default. The AI cites files inline.

const { useState: useStateA, useEffect: useEffectA, useRef: useRefA } = React;

function AskOverlay({ open, onClose, seed }) {
  const [thread, setThread] = useStateA([]);
  const [val, setVal] = useStateA('');
  const [thinking, setThinking] = useStateA(false);
  const scrollerRef = useRefA();
  const inputRef = useRefA();

  useEffectA(() => {
    if (open) {
      setThread([]);
      setVal('');
      // pre-seed if a query was provided
      if (seed) {
        ask(seed, /*fromSeed*/ true);
      } else {
        // a single soft greeting line, no thread yet
      }
      setTimeout(() => inputRef.current?.focus(), 320);
    }
  // eslint-disable-next-line
  }, [open, seed]);

  useEffectA(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [thread, thinking]);

  const ask = (q, fromSeed) => {
    if (!q || !q.trim()) return;
    setThread(prev => [...prev, { who: 'you', text: q.trim() }]);
    setVal('');
    setThinking(true);

    // simulate AI response — uses the canned one if it matches the seed pattern
    setTimeout(() => {
      const isAttention = /attention|winter|writ/i.test(q);
      const reply = isAttention ? SAMPLE_CONVERSATION[1] : {
        who: 'ai',
        text: `i looked through what you have. one moment — i can pull a few things, but you may want to narrow this. the most relevant items right now:`,
        cites: RECENT.slice(0, 3).map(r => ({ name: r.name, ext: r.ext, collection: collTitle(r.collection) })),
      };
      setThread(prev => [...prev, reply]);
      setThinking(false);
    }, 900);
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: open ? 'rgba(241,236,225,0.78)' : 'transparent',
        backdropFilter: open ? 'blur(8px)' : 'none',
        WebkitBackdropFilter: open ? 'blur(8px)' : 'none',
        zIndex: 50,
        pointerEvents: open ? 'auto' : 'none',
        opacity: open ? 1 : 0,
        transition: 'opacity 280ms ease, backdrop-filter 280ms ease',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '8vh',
      }}
    >
      <div
        className="t"
        style={{
          width: 'min(820px, 92vw)',
          maxHeight: '78vh',
          background: 'var(--surface-2)',
          border: '1px solid var(--hairline)',
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateY(0)' : 'translateY(20px)',
          opacity: open ? 1 : 0,
          boxShadow: '0 30px 80px -20px rgba(27,24,19,0.16), 0 8px 24px -8px rgba(27,24,19,0.08)',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 28px', borderBottom: '1px solid var(--hairline)' }}>
          <span className="serif-i" style={{ fontSize: 20, color: 'var(--ink)' }}>ask the library</span>
          <span className="quiet" style={{ fontSize: 12 }}>· searches your 718 files, 6 collections</span>
          <div style={{ flex: 1 }} />
          <span className="mono quiet" style={{ fontSize: 11 }}>esc</span>
          <button onClick={onClose} className="quiet" style={{ fontSize: 14 }}>close</button>
        </div>

        {/* thread */}
        <div ref={scrollerRef} style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, minHeight: 220 }}>
          {thread.length === 0 && !thinking && (
            <div style={{ padding: '24px 0', maxWidth: 540 }}>
              <div className="serif-i" style={{ fontSize: 28, color: 'var(--ink-2)', lineHeight: 1.25, marginBottom: 24 }}>
                what would you like to find?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  'what did i write about attention this winter?',
                  'find every contract with a renewal in 2026',
                  'three sentences i underlined this month',
                  'show photographs from kanazawa',
                ].map((s, i) => (
                  <button key={i} onClick={() => ask(s)} className="t-fast" style={{
                    textAlign: 'left',
                    padding: '12px 16px',
                    background: 'var(--surface)',
                    border: '1px solid var(--hairline)',
                    fontSize: 14,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e=>{e.currentTarget.style.background='var(--paper-deep)';}}
                  onMouseLeave={e=>{e.currentTarget.style.background='var(--surface)';}}
                  >{s}</button>
                ))}
              </div>
            </div>
          )}

          {thread.map((m, i) => (
            <ThreadBubble key={i} m={m} />
          ))}
          {thinking && (
            <div style={{ display: 'flex', gap: 10, padding: '12px 0', alignItems: 'center' }}>
              <span className="serif-i quiet" style={{ fontSize: 16 }}>thinking</span>
              <Dots />
            </div>
          )}
        </div>

        {/* input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 24px', borderTop: '1px solid var(--hairline)', background: 'var(--surface)' }}>
          <span className="serif-i quiet" style={{ fontSize: 18 }}>ask</span>
          <input
            ref={inputRef}
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { ask(val); }
              if (e.key === 'Escape') onClose();
            }}
            placeholder="ask anything…"
            style={{ flex: 1, fontSize: 15 }}
          />
          <Chord keys={['↵']} />
        </div>
      </div>
    </div>
  );
}

function ThreadBubble({ m }) {
  const isYou = m.who === 'you';
  return (
    <div style={{
      padding: '14px 0',
      animation: 'fade-up 320ms cubic-bezier(.22,.61,.36,1) both',
    }}>
      <div className="mono quiet" style={{ fontSize: 11, letterSpacing: '0.08em', marginBottom: 6 }}>
        {isYou ? 'you' : 'library'}
      </div>
      <div className={isYou ? 'serif-i' : ''} style={{
        fontSize: isYou ? 22 : 15,
        color: 'var(--ink)',
        lineHeight: 1.5,
        maxWidth: isYou ? 720 : 640,
      }}>{m.text}</div>

      {m.cites && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 600 }}>
          {m.cites.map((c, i) => (
            <div key={i} className="t-fast" style={{
              display: 'grid', gridTemplateColumns: '36px 1fr 200px',
              alignItems: 'center', gap: 14,
              padding: '10px 14px',
              background: 'var(--surface)',
              border: '1px solid var(--hairline)',
              cursor: 'pointer',
            }}
            onMouseEnter={e=>{e.currentTarget.style.background='var(--paper-deep)';}}
            onMouseLeave={e=>{e.currentTarget.style.background='var(--surface)';}}
            >
              <ExtTag ext={c.ext} />
              <div style={{ fontSize: 13 }}>{c.name}</div>
              <div className="serif-i quiet" style={{ fontSize: 13, textAlign: 'right' }}>{c.collection}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {[0,1,2].map(i => (
        <span key={i} style={{
          width: 4, height: 4, borderRadius: '50%', background: 'var(--ink-3)',
          animation: `pulse 1.2s ${i*0.18}s infinite ease-in-out`,
        }} />
      ))}
      <style>{`@keyframes pulse{0%,80%,100%{opacity:.2;transform:scale(.85);}40%{opacity:.9;transform:scale(1.1);}}`}</style>
    </span>
  );
}

Object.assign(window, { AskOverlay });
