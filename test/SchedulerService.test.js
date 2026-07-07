/**
 * SchedulerService.test.js — schedule math. Firing twice in one slot spams
 * moves; never firing silently kills the feature. Both are one off-by-one away.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { isDue, lastScheduledTime, GRACE_MS } = require("../src/main/services/SchedulerService");

// Helper: local-time constructor for readable cases
function at(y, mo, d, h, mi = 0) { return new Date(y, mo - 1, d, h, mi).getTime(); }

const daily2am = { enabled: true, frequency: "daily", hour: 2, lastRunMs: 0 };

test("daily: due right after the hour, not before", () => {
  const s = { ...daily2am, lastRunMs: at(2026, 7, 5, 2) };
  assert.equal(isDue(s, at(2026, 7, 6, 1, 59)), false, "1:59am — yesterday's slot already ran");
  assert.equal(isDue(s, at(2026, 7, 6, 2, 0)), true, "2:00am — new slot");
});

test("daily: does not double-fire within the same slot", () => {
  const ranAt = at(2026, 7, 6, 2, 0);
  const s = { ...daily2am, lastRunMs: ranAt };
  assert.equal(isDue(s, at(2026, 7, 6, 2, 30)), false);
  assert.equal(isDue(s, at(2026, 7, 6, 23, 59)), false);
  assert.equal(isDue(s, at(2026, 7, 7, 2, 0)), true, "next day fires again");
});

test("grace window: laptop asleep at 2am, wakes 7am → still runs; wakes 9am → skips", () => {
  const s = { ...daily2am, lastRunMs: at(2026, 7, 5, 2) };
  assert.equal(isDue(s, at(2026, 7, 6, 7, 59)), true, "within 6h grace");
  assert.equal(isDue(s, at(2026, 7, 6, 8, 1)), false, "past grace — wait for tomorrow");
});

test("weekly: fires Sundays at the set hour, once", () => {
  // 2026-07-05 is a Sunday
  const s = { enabled: true, frequency: "weekly", hour: 9, lastRunMs: at(2026, 6, 28, 9) };
  assert.equal(isDue(s, at(2026, 7, 5, 9, 5)), true, "Sunday 9:05 fires");
  const ran = { ...s, lastRunMs: at(2026, 7, 5, 9, 5) };
  assert.equal(isDue(ran, at(2026, 7, 5, 10)), false, "same Sunday: no re-fire");
  assert.equal(isDue(ran, at(2026, 7, 8, 9)), false, "Wednesday: nothing");
});

test("disabled never fires", () => {
  assert.equal(isDue({ ...daily2am, enabled: false }, at(2026, 7, 6, 2)), false);
});

test("lastScheduledTime walks back across midnight and across weeks", () => {
  // Daily 23:00, asked at 00:30 → yesterday 23:00
  const d = lastScheduledTime({ frequency: "daily", hour: 23 }, at(2026, 7, 6, 0, 30));
  assert.equal(new Date(d).getDate(), 5);
  // Weekly hour 9 asked Saturday → previous Sunday
  const w = lastScheduledTime({ frequency: "weekly", hour: 9 }, at(2026, 7, 4, 12)); // Sat Jul 4
  const wd = new Date(w);
  assert.equal(wd.getDay(), 0);
  assert.equal(wd.getDate(), 28); // Sun Jun 28
});
