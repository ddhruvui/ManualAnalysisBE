// When the daily catalog refresh should actually run.
//
// GitHub Actions cron is UTC-only, and 05:00 in New York is 09:00 UTC in summer (EDT,
// UTC-4) but 10:00 UTC in winter (EST, UTC-5). The workflow therefore fires at both, and
// this decides: run once per New York day, at or after 05:00 local time. Rules, not an
// exact-hour match, because GitHub often starts scheduled jobs late:
//   winter  09:00Z = 04:00 EST → too early, skip   10:00Z = 05:00 EST → run
//   summer  09:00Z = 05:00 EDT → run               10:00Z = 06:00 EDT → done today, skip
// A run delayed past the second trigger still refreshes, and the later one then skips.

export const REFRESH_TIME_ZONE = 'America/New_York';
export const REFRESH_HOUR = 5;

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: REFRESH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** Wall-clock time in New York: { day: "2026-07-15", hour: 5, label: "2026-07-15 05:00 EDT" }. */
export function newYorkTime(date) {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, hour: Number(p.hour), label: `${day} ${p.hour}:${p.minute} ${p.timeZoneName}` };
}

/**
 * @param {Date} now
 * @param {Date|null} lastBuiltAt  builtAt of the saved snapshot, if any
 * @param {boolean} force          manual run: always refresh
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldRefresh(now, lastBuiltAt, force = false) {
  const local = newYorkTime(now);
  if (force) return { run: true, reason: `manual run at ${local.label}` };
  if (local.hour < REFRESH_HOUR) {
    return { run: false, reason: `${local.label} is before ${REFRESH_HOUR}:00 New York time` };
  }
  if (lastBuiltAt) {
    const last = newYorkTime(lastBuiltAt);
    if (last.day === local.day && last.hour >= REFRESH_HOUR) {
      return { run: false, reason: `already refreshed today at ${last.label}` };
    }
  }
  return { run: true, reason: `daily refresh at ${local.label}` };
}
