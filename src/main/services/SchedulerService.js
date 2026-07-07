/**
 * SchedulerService.js — quiet clean on a schedule.
 *
 * "Every night at 2am, file whatever is sitting loose in my folder, and tell
 * me about it in the morning." No cron strings, two knobs: frequency
 * (daily | weekly) and hour (0-23). Weekly runs on Sunday.
 *
 * The service owns schedule math + the run loop; the actual per-file pipeline
 * (classify → move → index → undo-log) is injected by main so this file has
 * zero Electron dependencies and the math is unit-testable.
 *
 * Missed windows (laptop asleep at 2am): next wake-up check notices the
 * window was missed by < GRACE_MS and runs anyway — a sleeping laptop
 * shouldn't mean a week of no cleanup.
 */

const CHECK_INTERVAL_MS = 60 * 1000;      // look at the clock once a minute
const GRACE_MS = 6 * 60 * 60 * 1000;      // run late if we missed by < 6 h

const DEFAULTS = {
  enabled: false,
  frequency: "daily",   // "daily" | "weekly"
  hour: 2,              // local hour 0-23
  chrono: false,        // also file into Year subfolders (chronological filing)
  lastRunMs: 0,
};

/**
 * The scheduled fire time (ms) that immediately precedes or equals `nowMs`.
 * Pure function — the heart of the scheduler, fully tested.
 */
function lastScheduledTime(settings, nowMs) {
  const now = new Date(nowMs);
  const fire = new Date(nowMs);
  fire.setHours(settings.hour, 0, 0, 0);

  if (settings.frequency === "weekly") {
    // Walk back to Sunday
    fire.setDate(fire.getDate() - fire.getDay());
    if (fire.getTime() > nowMs) fire.setDate(fire.getDate() - 7);
  } else {
    if (fire.getTime() > nowMs) fire.setDate(fire.getDate() - 1);
  }
  return fire.getTime();
}

/**
 * Should a run fire right now?
 * True when: enabled, the most recent scheduled slot hasn't been run yet,
 * and we're within the grace window of that slot.
 */
function isDue(settings, nowMs = Date.now()) {
  if (!settings || !settings.enabled) return false;
  const slot = lastScheduledTime(settings, nowMs);
  if (settings.lastRunMs >= slot) return false;     // already ran this slot
  return nowMs - slot <= GRACE_MS;                  // not too stale
}

// ── Runtime loop (thin) ─────────────────────────────────────────────────

let _timer = null;

/**
 * Start the loop.
 * @param {() => object} getSettings — returns current settings (persisted by caller)
 * @param {(ranAtMs: number) => void} markRan — persist lastRunMs
 * @param {() => Promise<{moved:number, skipped:number}>} runClean — the actual clean
 * @param {(summary: {moved:number, skipped:number}) => void} [notify]
 */
function startScheduler(getSettings, markRan, runClean, notify) {
  stopScheduler();
  _timer = setInterval(async () => {
    try {
      const settings = { ...DEFAULTS, ...getSettings() };
      if (!isDue(settings)) return;
      markRan(Date.now()); // mark FIRST — a crash mid-run must not cause rerun loops
      const summary = await runClean();
      console.log(`[Scheduler] Quiet clean done: ${summary.moved} filed, ${summary.skipped} left alone`);
      if (notify) notify(summary);
    } catch (err) {
      console.warn(`[Scheduler] Quiet clean failed: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);
  // Don't keep the process alive just for the scheduler
  if (_timer.unref) _timer.unref();
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { isDue, lastScheduledTime, startScheduler, stopScheduler, DEFAULTS, GRACE_MS };
