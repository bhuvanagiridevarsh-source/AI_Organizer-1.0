# System Janitor — Reddit Prospecting Playbook

I couldn't fetch Reddit directly (it blocks automated access), so this gives you (1) the exact searches to find the posts yourself and (2) draft replies for the seven post archetypes you'll actually encounter. Paste real posts back into the chat and I'll tailor replies to each.

---

## Part 1: The searches (~15 min)

Use Reddit's own search with these URLs — set **Sort: New** and **Time: Past 3 months** on each results page. Pattern: `reddit.com/r/SUBREDDIT/search/?q=QUERY&restrict_sr=1&sort=new&t=quarter`

| Subreddit | Queries to run |
|---|---|
| r/macapps | `organize downloads` · `hazel alternative` · `file organizer` |
| r/windows | `organize files automatically` · `downloads folder mess` |
| r/productivity | `file organization system` · `digital declutter` · `can't find files` |
| r/software | `file organizer` · `automatically sort files` |
| r/DataHoarder | `organize collection` · `sorting files` · `folder structure` |
| r/Entrepreneur | `document organization` · `files mess` |
| r/smallbusiness | `organize documents` · `find files` |
| r/freelance | `organize client files` · `file management` |
| r/photography | `organize photos folders` · `culling workflow` · `file naming` |

Also worth searching (better fit than some on your list): **r/AskPhotography**, **r/Lightroom**, **r/LocalLLaMA** (`local file organization`), **r/privacy** (`local AI tools`), **r/ObsidianMD** (`file organization`).

Google also works for this even though my tooling can't use it on Reddit: `site:reddit.com/r/macapps "organize" files after:2026-04-01`

**Drop r/legaladvice.** It's for legal questions, bans product recommendations, and is aggressively moderated — a tool suggestion there gets removed and possibly banned. For the lawyer audience, r/paralegal and r/LawFirm occasionally have "how do you organize case files" threads; tread carefully even there.

---

## Part 2: Ground rules (this determines whether you get sales or banned)

- **Always disclose.** "I built an app for exactly this" outperforms stealth shilling and is required by most subs' self-promo rules — and by basic honesty. Undisclosed promotion gets you banned and screenshotted.
- **Help first, for real.** Each draft below solves part of their problem with free/built-in tools before mentioning yours. If you strip that part out, don't post.
- **Ratio matters.** Reddit mods check history. Keep promotional comments under ~10% of your activity; comment normally in these subs too.
- **Only reply where it fits.** If a post is about photo *culling* or cloud sync, System Janitor isn't the answer. Forcing it burns credibility.
- **Max 1–2 replies per subreddit per week.** Ten replies in one day from one account looks like a bot campaign.

---

## Part 3: Draft replies by archetype

### A. "My Downloads folder is out of control" (r/macapps, r/windows, r/productivity)

> Two things that helped me before I went nuclear: (1) sort by file type first, not date — 80% of Downloads is installers and screenshots you can bulk-delete or archive in one pass; (2) on Mac, Hazel rules handle the predictable stuff (move .dmg older than 7 days to trash, screenshots to a Screenshots folder). On Windows, File Juggler does similar.
>
> The gap with rule-based tools is everything that doesn't match a pattern — random PDFs, client files, "document(4).docx". That gap annoyed me enough that I built an app for it (System Janitor — full disclosure, my product). It uses a small AI model running entirely on your machine to figure out what each file is and sort it, with a preview before anything moves. Free trial if the rules-based route doesn't get you there — but honestly, try the bulk-delete pass first, it's free and gets you most of the way.

### B. "Looking for a Hazel alternative / file automation tool" (r/macapps, r/software)

> Depends what's breaking for you in Hazel. If it's rule maintenance (my problem — every new file type needed a new rule), the options are roughly: Hazel with smarter catch-all rules, shell scripts + launchd if you're technical, or the newer AI-classification approach.
>
> I built one of the latter (System Janitor — disclosure: mine) after my Hazel setup hit 40+ rules and still missed things. Instead of rules, a local model reads the file name/content and classifies it — nothing uploads anywhere, works offline. Tradeoff to be honest about: it's less deterministic than Hazel. Rules do exactly what they say; a model occasionally files something somewhere defensible-but-not-what-you-wanted, which is why everything previews first. If your workflow needs 100% predictability, stick with rules. If your problem is the files rules can't catch, that's the use case. Happy to answer questions either way.

### C. "I can never find anything on my computer" (r/productivity, r/smallbusiness)

> Quick wins before any new software: Everything (Windows) or Alfred/Raycast (Mac) for instant filename search — half of "I can't find files" is actually "Explorer/Finder search is slow," and those fix it in a day. Search only fails when you can't remember what the file was *called*, which is where structure starts mattering.
>
> For the structure side: I built an app (System Janitor — mine, to be upfront) that sorts files into folders using AI that runs locally on your machine — nothing uploaded. But genuinely, install Everything/Raycast first. If great search solves it, you don't need my thing.

### D. "How do you organize client files?" (r/freelance, r/smallbusiness, r/Entrepreneur)

> The structure that survived for me: `Clients/[Name]/[Year]/[Project]` with a `_Contracts` folder per client, plus a strict rule that everything gets a client name in the filename. The structure is easy — the discipline of filing into it is what fails.
>
> That failure is why I built System Janitor (disclosure: my app) — it watches Downloads and files things into your existing client structure automatically, using AI that runs entirely on your machine, so client contracts never touch a cloud service. Preview + undo on everything. But the folder convention above costs nothing and is the real fix; my app just automates the maintenance.

### E. "Organizing a huge collection" (r/DataHoarder)

> At [their scale], the boring answers matter most: decide checksums/structure *before* moving anything, and test any tool on a copy first — anything that moves files at scale can ruin your week.
>
> Disclosure upfront since this sub rightly hates stealth ads: I make an AI-based organizer (System Janitor) that classifies and sorts files with a local model — nothing uploads. Honest caveats for this sub specifically: I've only validated it to ~200k files, it moves files (breaks hardlinks — exclude seeding dirs), and media gets classified by name/metadata only, not content. If you want to stress-test it past 200k I'd actually love the failure logs — but for a pure media library, a dedicated tool like TinyMediaManager may fit better than a general organizer.

### F. "Best way to organize photos?" (r/photography — only reply if it's about *file/folder* chaos, not culling or editing)

> Most photographers land on date-based (`2026/2026-07-04_ShootName`) because it never needs a decision at import time — Lightroom/Capture One will build it for you on import, which is the real fix if you're using either.
>
> Where it breaks is the *other* stuff: client deliverables, exports, contracts, and everything outside the catalog. That half is what my app handles (System Janitor — disclosure, I built it): local AI sorts non-catalog files by what they are, nothing uploads (matters if client galleries are under NDA). It reads names/metadata, not image content, so it won't replace culling tools — different job. For RAW organization proper, import presets in your editor beat any external tool.

### G. "Privacy-focused / local AI tools?" (r/privacy, r/LocalLLaMA, sometimes r/software)

> The consumer local-AI space is thinner than it should be — mostly chat UIs (Ollama, LM Studio, Jan) rather than tools that *do* something.
>
> I'm building in that gap, so disclosure: System Janitor is mine — a file organizer running a bundled quantized model fully offline. No account, no telemetry; it works with networking disabled, which is verifiable with Little Snitch/Wireshark rather than something you have to take on faith. For this crowd the honest tradeoff: bundled small model means convenience over choice — you can't swap in your own model yet. If you'd rather point a tool at your own Ollama instance, tell me — it's the most-requested feature and I'm gauging demand.

---

## Part 4: Workflow from here

1. Run the Part 1 searches, collect candidate posts (aim for 15–20, you'll discard half).
2. Paste the links + post text (or screenshots) into this chat.
3. I'll write a reply tailored to each specific post — the archetype drafts above are starting points, and a reply that quotes the OP's actual situation converts several times better than a template.
