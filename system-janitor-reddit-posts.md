# System Janitor — Reddit Launch Posts (Beta)

Pricing note used throughout: pricing isn't final. Posts say you're weighing ~$10/mo vs. a one-time purchase and ask for input. This reads honest and drives comments.

---

## 1. r/macapps

**Title:**
I built a file organizer that runs a local LLM to sort your messy folders — no cloud, nothing leaves your Mac. Looking for beta testers.

**Body:**

My Downloads folder had 4,300 items in it. Screenshots, DMGs from apps I installed once in 2023, seventeen files named "invoice(3).pdf". I'd tried Hazel-style rules, but rules break the moment a file doesn't match a pattern — and most of my files don't.

So I built System Janitor. It runs a small language model entirely on-device, reads file names and a snippet of content, and files things into a folder structure it proposes (or one you define). Nothing is uploaded anywhere — no account, no telemetry, works offline. You can verify with Little Snitch if you don't trust me, which honestly you shouldn't, I'm a stranger on the internet.

How it works: point it at a folder, it shows you a full dry-run preview of every proposed move, you approve or edit, and there's a complete undo log if it gets something wrong.

Honest limitations right now:

- The local model is small, so it's not GPT-smart. It nails obvious stuff (invoices, screenshots, installers) but ambiguous files sometimes land in a "Review" folder instead of being guessed at.
- First scan of a big folder is slow — a few minutes for ~10k files on Apple Silicon. Intel Macs work but are noticeably slower.
- It doesn't understand image *content* yet, just names and metadata.

It's in beta and free while it is. Pricing after that isn't decided — I'm torn between ~$10/mo and a one-time purchase (I personally hate subscriptions for utilities, so I'd love opinions on that too).

If you want to throw your Downloads folder at it, link's in the comments per sub rules. Mostly I want to know where it fails.

**First comment (you):**

A few details that didn't fit the post:

- The model is a quantized ~3B model bundled with the app, so no setup, no Ollama required. Uses ~4GB RAM while scanning, idle otherwise.
- Preview mode is the default — it never moves anything without approval. There's also a "watch folder" mode you can enable later once you trust it.
- It respects your existing structure: if you already have a system, it learns from where your files currently live instead of imposing its own.

Beta link: [LINK]. What I most need from testers: files it miscategorizes (there's a one-click "report this" that shares only the filename, nothing else, and only if you opt in). Also curious — what's everyone's Downloads folder count right now? Mine was 4,300 and I need to feel better about it.

---

## 2. r/windows

**Title:**
I was skeptical of "AI" file organizers too, so I built one that runs offline, shows you every move first, and can undo everything. Beta testers wanted.

**Body:**

Fair warning: this post contains the phrase "AI," but stay with me.

Every file organizer I tried on Windows was either a rules engine (breaks constantly, endless config) or some cloud thing that wanted to upload my documents to "organize" them. Hard no on both.

So I built System Janitor. The pitch is boring on purpose: it looks at your messy folders (Downloads, Desktop, Documents), figures out what each file is from its name and a bit of content, and sorts it into sensible folders. The "AI" is a small model that runs entirely on your PC. It works with the network cable unplugged. No account. No files uploaded, ever.

The part that matters if you're skeptical:

- Nothing moves without your approval. You get a full preview of every proposed move first.
- Full undo. Every move is logged and reversible in one click.
- If it's not sure about a file, it says so and leaves it alone rather than guessing.

Limitations, because everything has them:

- Needs a reasonably modern PC — 8GB RAM minimum, 16GB is comfortable. The model is doing real work.
- First scan of a huge folder takes a few minutes.
- It's not magic. Obvious files (installers, invoices, screenshots) sort great; a file named "asdf_final2.xlsx" with no clear content might end up in a Review pile.

It's free during beta. Pricing after isn't locked — considering ~$10/mo or a one-time purchase, leaning toward whatever people actually want.

Link in comments. If you think the AI part is a gimmick, I'd honestly like you to try it and tell me exactly where — that's more useful to me than praise.

**First comment (you):**

Technical details for those asking:

- Runs on Windows 10/11, x64. The model is bundled (~2GB download) — no Python, no dependencies, one installer.
- CPU-only works fine; if you have a GPU it'll use it and scan faster.
- It never touches system folders, Program Files, or anything outside the folders you explicitly point it at.

Beta link: [LINK]. The most useful bug reports are "it put X in Y and that's dumb because Z" — there's a feedback button on every proposed move. Also taking votes: subscription (~$10/mo, not final) vs. one-time purchase. I know which one Reddit will pick, but say it anyway.

---

## 3. r/productivity

**Title:**
Every file organization system I built collapsed within 3 weeks. So I made the maintenance automatic instead — beta testers wanted.

**Body:**

I've done PARA. I've done Johnny Decimal. I've done "just be disciplined about filing things." Each system worked for exactly as long as my enthusiasm did — about three weeks — and then Downloads became a junk drawer again.

The realization that changed my approach: the system was never the problem. The *maintenance* was. Filing files is a recurring chore, and recurring chores that depend on willpower fail.

So I built System Janitor: an app that does the filing for me. A small AI model runs locally on your machine (Mac or Windows — nothing goes to the cloud, works offline), reads what each file actually is, and files it into your structure. If you use PARA or Johnny Decimal, it learns your existing setup and maintains it. If you have no system, it proposes one.

My actual workflow now: everything gets saved to Downloads with zero thought. Once a day it sweeps, shows me a preview, I approve in about ten seconds. That's the entire system. Time spent filing went from "an ashamed hour every few months" to roughly a minute a day.

Where it falls short right now:

- The local model is small, so ambiguous files go to a Review folder instead of getting guessed — you'll still touch some files manually.
- The first pass over years of backlog takes a while and needs a real review from you. It's a one-time cost but it's real.

It's in beta and free for now. Post-beta pricing isn't final — likely ~$10/mo or possibly a one-time purchase, still deciding.

Link in comments. I'd especially love testers who run PARA/JD setups — you'll stress the "learn my existing structure" feature harder than anyone.

**First comment (you):**

More on how it fits into a workflow, since that's the point here:

- You can define rules in plain English — "anything that looks like a receipt goes to Finance/2026, screenshots older than 30 days get archived" — and the model interprets them. No regex.
- It has a scheduled sweep mode (daily/weekly) with the preview-and-approve step, so it stays a habit that costs seconds, not willpower.
- The undo log doubles as a record of what changed, which helped me trust it during week one.

Beta link: [LINK]. Question for this sub: what made *your* last filing system collapse? I'm collecting failure modes — the app exists because of mine, and I want to make sure it covers yours.

---

## 4. r/Entrepreneur

**Title:**
I timed how long I spent looking for files last quarter: 9 hours. Built a tool to fix it, looking for beta users before I finalize pricing.

**Body:**

Quick math that annoyed me into building something: I tracked my time for a quarter and spent about 9 hours just *finding files*. Invoices for the accountant, a contract from eight months ago, the logo file the designer sent (was it email? Slack? Downloads?). At any reasonable hourly value, that's real money spent on nothing.

The problem wasn't that I'm disorganized — it's that filing documents properly is nobody's job, so it doesn't happen. Every small business I know runs on a Downloads folder full of chaos.

So I built System Janitor. It uses a small AI model that runs entirely on your own computer to read what each document actually is — invoice, contract, receipt, tax doc — and file it accordingly. Two things matter for business use:

1. Nothing leaves your machine. No cloud, no third party touching client contracts or financials. It works offline. If you handle sensitive client data, that's the whole reason I built it this way.
2. It shows you every proposed move before making it, and everything's undoable.

Real result from my own use: tax prep this year meant opening one folder where every 2025 receipt and invoice already lived, instead of a weekend of archaeology.

Limitations, honestly:

- It reads names and text content. Scanned documents work only if they contain a text layer — pure image scans are hit or miss for now.
- Ambiguous files get parked in a Review folder rather than guessed at. You'll still make some calls yourself.
- It organizes your local machine — it doesn't reach into Google Drive or Dropbox web-side yet (a synced local folder works fine).

Beta is free. Pricing after isn't confirmed — modeling ~$10/mo, but a one-time purchase is on the table, and frankly I'd like input from people who buy business tools.

Link in comments. Most useful testers: anyone drowning in invoices, contracts, and client deliverables.

**First comment (you):**

Adding the business-relevant specifics:

- You can set up client- or project-based structures ("everything mentioning Acme Corp goes under Clients/Acme") in plain English.
- Works on Mac and Windows, so mixed-machine teams are fine. No per-seat account system during beta — it's just an app.
- Since it's fully local, there's no vendor processing agreement to think about for client-confidential docs. Your files, your machine, full stop.

Beta link: [LINK]. Genuine question for this sub: for a tool like this, does your accountant/ops brain prefer a subscription (~$10/mo, not final) or one-time license? The answer actually changes what I build next (subscription would fund ongoing model improvements; one-time means bigger, slower releases).

---

## 5. r/DataHoarder

**Title:**
Built a local-AI file organizer and I need people with genuinely huge collections to break it. Current tested ceiling: ~200k files.

**Body:**

Upfront: I know this sub's relationship with "organizing" is complicated — the hoard is the point. This isn't a dedupe tool or a "delete your files" tool. It never deletes anything. It sorts.

System Janitor runs a small LLM locally (Mac/Windows, fully offline, zero network calls — watch it in Wireshark if you like) and classifies files by name, metadata, and content snippets, then moves them into a structure you define or approve. Full dry-run preview, complete undo log, every move journaled.

Why I'm posting here specifically: you people have collections that will find every wall this thing has, and I'd rather find those walls now.

Known limits going in — I'll save you some time:

- Largest collection I've personally tested is ~200k files. Beyond that, indexing memory climbs and I genuinely don't know where it falls over. That's the data I want.
- Network shares/NAS: it treats mounted volumes as regular folders but I haven't stress-tested SMB/NFS latency. Slow mounts probably make scans painful.
- It reads content snippets, so first-pass scans on spinning rust will be I/O-bound and slow. SSD-resident collections scan far faster.
- No content-based analysis of media files yet — video/audio/images get classified by name, container metadata, and EXIF only.
- It moves files, which breaks hardlinks and will make your torrent client very unhappy if you point it at seeding directories. Don't. (Exclusion rules exist for this.)

Beta is free. Eventual pricing not settled — ~$10/mo floated, one-time purchase possible, and I suspect this sub has opinions on subscription software.

Link in comments. If you point it at 500k+ files and it survives, I want the log. If it dies, I want that log more.

**First comment (you):**

Extra details for the people already opening task manager:

- Indexing is resumable — if a scan dies or you kill it, it picks up where it left off rather than restarting.
- Everything is journaled to a local SQLite DB, so "what did it do and when" is always answerable, and undo works even across restarts.
- You can scope it hard: include/exclude by path, extension, size, and age. Seeding dirs, VM images, and anything else sacred can be walled off.

Beta link: [LINK]. Current record among testers is 200k files / 4TB. If you beat that, comment with your file count, drive setup, and scan time — I'll keep a leaderboard in this thread. And yes, one-time purchase is genuinely being considered; I've read this sub before.
