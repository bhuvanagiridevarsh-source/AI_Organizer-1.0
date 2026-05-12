// Mock dataset for the AI library. Designed to feel like a real working library:
// - mixed file types
// - dates that read as "lived in"
// - clusters the AI plausibly assembled
// Names are deliberately mundane.

const FILE_TYPES = {
  pdf:   { label: 'pdf',   tone: 'doc' },
  doc:   { label: 'doc',   tone: 'doc' },
  md:    { label: 'note',  tone: 'doc' },
  img:   { label: 'image', tone: 'media' },
  code:  { label: 'code',  tone: 'code' },
  audio: { label: 'audio', tone: 'media' },
  video: { label: 'video', tone: 'media' },
  link:  { label: 'link',  tone: 'link' },
  csv:   { label: 'sheet', tone: 'doc' },
};

// Collections — what the AI quietly sorted things into.
const COLLECTIONS = [
  { id: 'field-notes',   title: 'field notes',           sub: 'observations · journals · half-finished ideas',     count: 47,  hue: 'paper',  pinned: true,  updated: 'tuesday' },
  { id: 'research',      title: 'research, ongoing',     sub: 'longform reading + the threads you keep pulling',    count: 142, hue: 'indigo', pinned: true,  updated: '14 minutes ago' },
  { id: 'design-refs',   title: 'design references',     sub: 'screenshots, sketches, things to remember',          count: 89,  hue: 'paper',  pinned: false, updated: 'monday' },
  { id: 'contracts',     title: 'contracts & finance',   sub: 'agreements, invoices, the boring necessary',         count: 31,  hue: 'sand',   pinned: false, updated: 'last week' },
  { id: 'photos-2025',   title: 'photographs, 2025',     sub: 'a year, sorted by where you were',                   count: 318, hue: 'paper',  pinned: false, updated: 'march' },
  { id: 'correspondence',title: 'correspondence',        sub: 'emails worth keeping, letters, replies owed',        count: 76,  hue: 'paper',  pinned: false, updated: 'this morning' },
];

// Recent — the last things you touched.
const RECENT = [
  { id: 'r1', name: 'quarterly_review_draft_v4',   ext: 'doc',  collection: 'research',     opened: '12 min',   size: '128 kB' },
  { id: 'r2', name: 'kanazawa_morning',            ext: 'img',  collection: 'photos-2025',  opened: '1 h',      size: '4.2 MB' },
  { id: 'r3', name: 'lease_2026',                  ext: 'pdf',  collection: 'contracts',    opened: 'today',    size: '312 kB' },
  { id: 'r4', name: 'a-conversation-with-takeshi', ext: 'audio',collection: 'field-notes',  opened: 'today',    size: '38 MB' },
  { id: 'r5', name: 'rooms_we_have_loved',         ext: 'md',   collection: 'field-notes',  opened: 'yesterday',size: '6 kB' },
];

// Inbox — unsorted, awaiting placement. The AI has guesses.
const INBOX = [
  { id: 'i1',  name: 'IMG_4421',                       ext: 'img',  guess: 'photographs, 2025',  confidence: 0.97 },
  { id: 'i2',  name: 'screenshot 2026-05-08 09.14.22', ext: 'img',  guess: 'design references',  confidence: 0.91 },
  { id: 'i3',  name: 'invoice_marquette_may',          ext: 'pdf',  guess: 'contracts & finance',confidence: 0.99 },
  { id: 'i4',  name: 'untitled-meeting-rec',           ext: 'audio',guess: 'field notes',        confidence: 0.74 },
  { id: 'i5',  name: 'a piece on attention',           ext: 'md',   guess: 'research, ongoing',  confidence: 0.88 },
  { id: 'i6',  name: 'kawai_hours.csv',                ext: 'csv',  guess: 'contracts & finance',confidence: 0.62 },
  { id: 'i7',  name: 'quiet rooms — pinterest',        ext: 'link', guess: 'design references',  confidence: 0.84 },
  { id: 'i8',  name: 'IMG_4422',                       ext: 'img',  guess: 'photographs, 2025',  confidence: 0.97 },
  { id: 'i9',  name: 'IMG_4423',                       ext: 'img',  guess: 'photographs, 2025',  confidence: 0.97 },
  { id: 'i10', name: 'second-draft-of-the-letter',     ext: 'md',   guess: 'correspondence',     confidence: 0.79 },
  { id: 'i11', name: 'reading_list_q2',                ext: 'doc',  guess: 'research, ongoing',  confidence: 0.81 },
  { id: 'i12', name: 'morning_thought_05.08',          ext: 'audio',guess: 'field notes',        confidence: 0.69 },
];

// Files inside a specific collection (research, ongoing) for the detail view.
const COLLECTION_FILES = {
  research: [
    { id: 'rs1',  name: 'on the discipline of attention', ext: 'md',   updated: 'this morning', size: '8 kB',  pinned: true },
    { id: 'rs2',  name: 'simon — sciences of the artificial (excerpts)', ext: 'pdf',  updated: 'tuesday',  size: '2.1 MB' },
    { id: 'rs3',  name: 'a year reading less',            ext: 'md',   updated: 'tuesday',     size: '12 kB' },
    { id: 'rs4',  name: 'cal newport — deep work, notes', ext: 'doc',  updated: 'last week',   size: '46 kB' },
    { id: 'rs5',  name: 'calm-tech-principles',           ext: 'pdf',  updated: 'mar 14',      size: '880 kB', pinned: true },
    { id: 'rs6',  name: 'screenshot — three principles',  ext: 'img',  updated: 'mar 12',      size: '2.4 MB' },
    { id: 'rs7',  name: 'highlights — borges, library of babel', ext: 'md', updated: 'mar 02', size: '4 kB' },
    { id: 'rs8',  name: 'the question of taste',          ext: 'md',   updated: 'feb 28',      size: '7 kB' },
    { id: 'rs9',  name: 'donella meadows — places to intervene', ext: 'pdf', updated: 'feb 19', size: '420 kB' },
    { id: 'rs10', name: 'reading_list_q1.csv',            ext: 'csv',  updated: 'feb 11',      size: '6 kB' },
    { id: 'rs11', name: 'paragraph i keep returning to',  ext: 'md',   updated: 'feb 04',      size: '2 kB' },
    { id: 'rs12', name: 'is attention a form of love',    ext: 'audio',updated: 'jan 28',      size: '34 MB' },
  ]
};

// Files for collections that aren't the research one — keep these lighter.
const SAMPLE_FILES_FOR = (id) => {
  if (COLLECTION_FILES[id]) return COLLECTION_FILES[id];
  return [
    { id: id+'_a', name: 'item a', ext: 'md',  updated: 'today',     size: '4 kB' },
    { id: id+'_b', name: 'item b', ext: 'pdf', updated: 'tuesday',   size: '120 kB' },
    { id: id+'_c', name: 'item c', ext: 'img', updated: 'last week', size: '2.1 MB' },
  ];
};

// AI-suggested actions — the "5S" thinking surfacing as gentle prompts, never named.
const SUGGESTIONS = [
  { id: 's1', kind: 'archive', title: 'eight files have not been opened in six months. archive them?', count: 8 },
  { id: 's2', kind: 'merge',   title: 'three near-duplicates in design references. keep the largest?',  count: 3 },
  { id: 's3', kind: 'rename',  title: 'twelve screenshots could carry their subject as a name.',         count: 12 },
];

// Conversation stub for the ask view.
const SAMPLE_CONVERSATION = [
  { who: 'you', text: 'what did i write about attention this winter?' },
  { who: 'ai', text: 'three pieces, mostly. the longest is "on the discipline of attention" from this morning — eight kilobytes, the one you keep returning to. the other two are shorter:',
    cites: [
      { name: 'on the discipline of attention', ext: 'md', collection: 'research, ongoing' },
      { name: 'a year reading less',            ext: 'md', collection: 'research, ongoing' },
      { name: 'is attention a form of love',    ext: 'audio', collection: 'research, ongoing' },
    ]
  },
];

Object.assign(window, { FILE_TYPES, COLLECTIONS, RECENT, INBOX, COLLECTION_FILES, SAMPLE_FILES_FOR, SUGGESTIONS, SAMPLE_CONVERSATION });
