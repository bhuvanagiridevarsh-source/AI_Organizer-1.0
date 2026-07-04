# Fable 5 Prompts — System Janitor Launch Sprint

Use these in order. Day 1 = 2x limits day (most complex work first).

---

## DAY 1 — Deep Code Review + Bug Hunt
*Paste this into a fresh Fable 5 conversation. Attach all files listed.*

---

### PROMPT 1A: Full Service Audit

```
You are doing a pre-launch security and reliability audit of System Janitor — an Electron desktop app that uses a local LLM to organize files. It runs entirely on the user's machine. Before I charge real customers, I need you to find every real bug, edge case, and failure mode.

I'm going to paste the contents of my core service files. For each one, I want you to:
1. Find actual bugs (not style issues)
2. Find failure modes that would frustrate or lose a paying customer
3. Find any security issues (especially in licenseService and anything touching the filesystem)
4. Rate each issue: CRITICAL / HIGH / MEDIUM and explain why

Files to audit (I'll paste them one by one):
- src/main/services/licenseService.js
- src/main/services/ClassificationService.js
- src/main/services/fileService.js
- src/main/services/UndoLogService.js
- src/main/services/WatcherService.js
- src/main/services/LlamaService.js
- src/main/services/WorkflowEngine.js

Start after I paste the first file. Don't summarize — just find real problems.
```

---

### PROMPT 1B: License + Payment Flow Security

```
You are auditing the license and payment flow of System Janitor, an Electron desktop app. Here is how the system works:

1. Customer pays on Stripe checkout
2. Stripe fires checkout.session.completed to a Vercel webhook
3. Webhook generates a UUID license key, inserts into Supabase, emails it via Resend
4. Customer opens app → Settings → License → pastes key → clicks Activate
5. App calls /api/license/validate → Supabase confirms key → cached 24 hours locally in electron-store

I need you to find every way someone could:
- Bypass the license check without paying
- Crack or spoof a license key
- Abuse the system (e.g., share one key with many users)
- Break the flow so a real paying customer can't activate

Then tell me exactly how to fix each one.

Here is my licenseService.js: [PASTE FILE]
Here is my backend webhook handler: [PASTE backend/api/webhooks/stripe.js or equivalent]
Here is my license validate endpoint: [PASTE backend/api/license/validate.js or equivalent]
```

---

### PROMPT 1C: Filesystem Safety Audit

```
System Janitor moves and renames real files on a user's computer. A bug here means data loss — which means chargebacks, 1-star reviews, and a dead product.

Audit my file operation code for:
1. Any scenario where files could be permanently deleted instead of moved
2. Race conditions (watcher fires while organizer is mid-move)
3. What happens if the app crashes mid-operation
4. Whether the undo log actually works to recover from a bad organization run
5. Edge cases: symlinks, aliases, locked files, files with identical names, very long paths, non-ASCII filenames

Here is my code: [PASTE fileService.js, UndoLogService.js, WatcherService.js]

For every issue found, give me the exact fix — code, not just description.
```

---

## DAY 2 — Mass Test Data + Stress Test
*New conversation. These are self-contained.*

---

### PROMPT 2A: Generate Realistic Messy File Structure

```
Write a Node.js script that generates a realistic, deeply messy folder structure for testing a file organizer app. The script should create files in a target directory I specify.

Requirements:
- 500–1000 files total
- Mix of: invoices (PDF names), photos (IMG_xxxx, DSC_xxxx), screenshots, documents (Word, random names), spreadsheets, code files, zip files, duplicates with slightly different names
- Nested up to 4 folders deep, but most files dumped in root
- Include: files with spaces in names, files with special characters, very long filenames, files with no extension, hidden files (dot prefix)
- Include ~50 genuine duplicates (same content, different names)
- Include ~30 near-duplicates (similar names, slightly different)
- Files should have realistic sizes (use Buffer.alloc with random bytes, not just touch)

The script should accept a --target /path/to/folder argument and print a summary when done.

Make it runnable with: node generate-test-data.js --target ./stress_test_folder
```

---

### PROMPT 2B: Automated Stress Test + Output Validator

```
I have an Electron file organizer app called System Janitor. After running it on a test folder, I need to validate the quality of what it did.

Write a Node.js script that:
1. Takes --before /path and --after /path arguments (folder state before and after organizing)
2. Checks: were any files lost? (every file in before must exist in after, by content hash)
3. Checks: were any files duplicated unexpectedly?
4. Reports: how many files were moved, renamed, left in place
5. Reports: what categories were created and how many files went into each
6. Flags: any file that ended up in a folder that seems wrong (e.g., a .pdf invoice in a "Photos" folder)
7. Outputs a JSON report + human-readable summary

Also write a second script that snapshots a folder state (file list + hashes) so I can run it before and after organizing.

Make it: node snapshot.js --folder ./stress_test_folder > before.json
Then: node validate.js --before before.json --after ./organized_folder
```

---

### PROMPT 2C: Edge Case Torture Test

```
I'm stress testing System Janitor, an AI file organizer. Help me create specific edge case test scenarios that would break a naive file organizer.

For each scenario below, write the exact files/folder structure to create (as a shell script using touch, mkdir, etc.) and describe what the correct behavior should be:

1. Two files named "Invoice.pdf" and "invoice.pdf" in the same folder (case collision on case-insensitive filesystems)
2. A folder named "Photos" already exists — organizer tries to create another "Photos" folder
3. A file with a 255-character filename
4. A .pdf file that is actually an image (wrong extension)
5. A zip file containing 10,000 files
6. A symlink to a file outside the target folder
7. A file that's currently open in another app (locked)
8. A folder with 10,000 files all in the root
9. Files with emoji in the name (🎉 party.pdf)
10. A file with no read permissions

For each: what should happen, what would go wrong in a naive implementation, and what to check after running the organizer.
```

---

## DAY 3A — UI/UX Polish
*New conversation.*

---

### PROMPT 3A: UX Audit

```
You are a senior product designer doing a UX audit of System Janitor — an Electron desktop app that uses local AI to organize files. The target user is a non-technical professional (lawyer, freelancer, small business owner) whose Downloads and Desktop folders are a disaster.

I'm going to describe every screen and flow. For each one, tell me:
1. What would confuse a non-technical user
2. What copy/labels are unclear
3. What's missing that users will expect
4. Specific rewrites for any confusing copy (give me exact strings)
5. One highest-priority fix per screen

Screens (I'll describe each):

SCREEN 1 — Onboarding / First Launch
[Describe what the user sees when they first open the app]

SCREEN 2 — Folder Selection
[Describe the UI for picking a folder to organize]

SCREEN 3 — Preview (before confirming organization)
[Describe how the app shows what it's about to do]

SCREEN 4 — Organizing in progress
[Describe the progress UI]

SCREEN 5 — Results / Done
[Describe the completion screen]

SCREEN 6 — Settings
[Describe settings screen]

SCREEN 7 — License / Activation
[Describe the license entry UI]

Be brutal. Every confusion point is a lost customer.
```

---

### PROMPT 3B: Onboarding Rewrite

```
You are rewriting the onboarding experience for System Janitor — an Electron desktop app that organizes messy files using local AI. It runs 100% on your device, no cloud.

The current first-run experience is:
[DESCRIBE WHAT CURRENTLY HAPPENS]

The target user: non-technical professional. They downloaded this to fix their chaotic Downloads folder. They are skeptical AI can do this. They are nervous about it moving their files.

Rewrite the onboarding to:
1. Immediately show value (don't make them configure before they see anything)
2. Build trust around the "local only, no cloud" angle — this is our biggest differentiator
3. Handle the fear of files being moved wrong (show undo, show preview)
4. Get them to their first successful organization in under 2 minutes

Give me:
- Exact copy for each onboarding step (headline + subtext)
- What UI element appears on each step
- The exact sequence of steps (no more than 4)
- The empty state copy for the main screen before they've organized anything
```

---

## DAY 3B — AI-Assisted Customer Acquisition
*New conversation. These are ready to run.*

---

### PROMPT 4A: Reddit Launch Posts

```
Write Reddit posts for launching System Janitor — an AI file organizer that runs 100% locally on your Mac or Windows PC. No cloud, no subscription required (one-time purchase), no files ever leave your device. It organizes messy folders automatically using a local AI model.

Write posts for these subreddits (one post each, tailored to that community's tone):

1. r/macapps — Mac power users. They care about native feel, no bloat, privacy.
2. r/windows — Windows users. They want it to just work. Skeptical of AI gimmicks.
3. r/productivity — Productivity nerds. They want workflows, systems, time saved.
4. r/Entrepreneur — Small business owners. They care about time = money.
5. r/DataHoarder — People with massive file collections. They'll stress test it.

For each post:
- Title (must not sound like an ad — these communities ban self-promotion that reads like marketing)
- Body (conversational, honest, show the problem you're solving, invite feedback)
- A comment I should post as my first reply (adds info, invites engagement)

Rules: No hype. No "revolutionary." Show the problem first, then the solution. Include a real limitation or two — it builds trust.
```

---

### PROMPT 4B: Product Hunt Launch Kit

```
Write a complete Product Hunt launch kit for System Janitor — an AI file organizer that runs entirely on your device (Mac + Windows). Local AI model, no cloud, no subscription, one-time purchase.

Deliver:
1. Tagline (60 chars max) — 3 options ranked by your recommendation
2. Description (260 chars) — what it does, for whom, key differentiator
3. First comment (posted by maker on launch day) — 150–200 words. Should: tell the story of why you built it, what makes it different, invite feedback, include a specific question to drive comments
4. Topics/tags to select (Product Hunt lets you pick categories)
5. A list of 5 specific communities/newsletters to submit to on launch day for additional traffic
6. Suggested launch day (day of week) and why

Tone: honest builder, not a marketing department. Product Hunt rewards authenticity.
```

---

### PROMPT 4C: Cold Outreach to Potential Early Customers

```
Write cold outreach messages for System Janitor — a local AI file organizer, one-time purchase, runs on Mac + Windows with no cloud.

Target audiences (write one template per audience):

1. Freelance designers/photographers — they have thousands of assets in chaos
2. Real estate agents — tons of documents, contracts, photos, all disorganized  
3. Lawyers / paralegals — document heavy, care about privacy (local-only is huge for them)
4. Accountants / bookkeepers — receipts, invoices, tax docs everywhere
5. Small business owners — they know their files are a mess and have no time to fix it

For each template:
- Subject line (email) — 3 options
- Message body (150 words max) — lead with their pain, not your product. Mention local-only privacy as relevant. End with a single low-commitment CTA (try for free, not "buy now")
- A LinkedIn DM version (75 words max)

Make these sound like they're from a real person, not a SaaS marketing team. First-person, slightly informal.
```

---

### PROMPT 4D: Find Warm Leads on Reddit Right Now

```
I'm launching System Janitor, an AI file organizer. I need you to help me find people on Reddit who are already looking for exactly this.

Search for recent posts (last 3 months) on Reddit where people are:
- Complaining about messy/disorganized files
- Asking for file organization tools or software
- Looking for alternatives to manual file sorting
- Talking about not being able to find their files
- Asking about privacy-focused tools (local AI, no cloud)

For each post you find:
- Link to the post
- Summary of their problem
- A draft reply I can post that's genuinely helpful (not a spam ad) — mention the tool naturally, but only after actually helping them first

Subreddits to search: r/macapps, r/windows, r/productivity, r/software, r/DataHoarder, r/Entrepreneur, r/smallbusiness, r/freelance, r/photography, r/legaladvice

Give me 10 posts with draft replies.
```

---

## Bonus: The 1-Day 2x Limits Power Move

If you only have 1 day of 2x limits, use it on **Prompt 1A + 1B + 1C back to back in one conversation**. 
The extra context means Fable 5 can hold ALL your service files in memory at once and find cross-service bugs 
(e.g., a race condition between WatcherService and fileService that neither file shows alone).

Paste files in this order: licenseService → fileService → UndoLogService → WatcherService → ClassificationService → WorkflowEngine.
Then ask: "Now that you've seen all of them together, what cross-service bugs or failure modes do you see that you wouldn't catch looking at each file alone?"
