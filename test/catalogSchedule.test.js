import test from 'node:test';
import assert from 'node:assert/strict';
import { newYorkTime, shouldRefresh } from '../src/catalogSchedule.js';

const at = (iso) => new Date(iso);

test('New York wall clock follows EST in winter and EDT in summer', () => {
  assert.equal(newYorkTime(at('2026-01-15T10:00:00Z')).label, '2026-01-15 05:00 EST');
  assert.equal(newYorkTime(at('2026-07-15T09:00:00Z')).label, '2026-07-15 05:00 EDT');
});

test('winter: the 09:00 UTC trigger is 04:00 EST and skips; 10:00 UTC runs', () => {
  const yesterday = at('2026-01-14T10:00:00Z');
  assert.equal(shouldRefresh(at('2026-01-15T09:00:00Z'), yesterday).run, false);
  assert.equal(shouldRefresh(at('2026-01-15T10:00:00Z'), yesterday).run, true);
});

test('summer: the 09:00 UTC trigger is 05:00 EDT and runs; 10:00 UTC skips as done', () => {
  assert.equal(shouldRefresh(at('2026-07-15T09:00:00Z'), at('2026-07-14T09:00:00Z')).run, true);
  const after = shouldRefresh(at('2026-07-15T10:00:00Z'), at('2026-07-15T09:01:00Z'));
  assert.equal(after.run, false);
  assert.match(after.reason, /already refreshed today/);
});

test('clock-change days pick the right trigger', () => {
  // 2026-03-08: clocks spring forward at 02:00, so 05:00 is EDT = 09:00 UTC.
  assert.equal(shouldRefresh(at('2026-03-08T09:00:00Z'), at('2026-03-07T10:00:00Z')).run, true);
  assert.equal(shouldRefresh(at('2026-03-08T10:00:00Z'), at('2026-03-08T09:00:30Z')).run, false);
  // 2026-11-01: clocks fall back at 02:00, so 05:00 is EST = 10:00 UTC.
  assert.equal(shouldRefresh(at('2026-11-01T09:00:00Z'), at('2026-10-31T09:00:00Z')).run, false);
  assert.equal(shouldRefresh(at('2026-11-01T10:00:00Z'), at('2026-10-31T09:00:00Z')).run, true);
});

test('a late GitHub start still refreshes once, and only once', () => {
  // Winter 09:00 trigger delayed to 10:20 UTC (05:20 EST): runs…
  assert.equal(shouldRefresh(at('2026-01-15T10:20:00Z'), at('2026-01-14T10:00:00Z')).run, true);
  // …and the 10:00 trigger arriving after it skips.
  assert.equal(shouldRefresh(at('2026-01-15T10:25:00Z'), at('2026-01-15T10:20:00Z')).run, false);
});

test('a snapshot written before 05:00 (e.g. a manual run) does not count as today’s refresh', () => {
  assert.equal(shouldRefresh(at('2026-01-15T10:00:00Z'), at('2026-01-15T07:00:00Z')).run, true);
});

test('first run with no snapshot, and --force, always refresh', () => {
  assert.equal(shouldRefresh(at('2026-01-15T10:00:00Z'), null).run, true);
  assert.equal(shouldRefresh(at('2026-01-15T03:00:00Z'), at('2026-01-15T02:00:00Z'), true).run, true);
});
