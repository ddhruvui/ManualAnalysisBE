import test from 'node:test';
import assert from 'node:assert/strict';

// digest.js imports the db/config modules, which need env + a cache dir; point them at
// throwaway values before loading it. No network or real data is touched.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.RUNPOD_VOLUME_ID ??= 'test';
process.env.RUNPOD_S3_REGION ??= 'test';
process.env.RUNPOD_S3_ENDPOINT ??= 'https://example.test';
process.env.CACHE_DIR = (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'digest-test-'),
);

const { selectArticles } = await import('../src/digest.js');

const DAY = 86_400_000;
const row = (i, { day = 0, symbolCount = 10, title = `Synthetic headline ${i}` } = {}) => ({
  id: String(i).padStart(20, '0'),
  ts: day * DAY + i,
  date: new Date(day * DAY + i).toISOString(),
  title,
  polarity: 0,
  symbolCount,
});

test('keeps everything (oldest first) when under the cap', () => {
  const rows = [row(3), row(1), row(2)];
  const { unique, selected } = selectArticles(rows, 'TEST', 10);
  assert.equal(unique, 3);
  assert.deepEqual(selected.map((r) => r.ts), [1, 2, 3]);
});

test('drops syndicated duplicates, keeping the most focused copy', () => {
  const rows = [
    row(1, { title: 'Big News: Acme beats estimates', symbolCount: 20 }),
    row(2, { title: 'Big news — Acme beats estimates!', symbolCount: 2 }),
    row(3, { title: 'Something else' }),
  ];
  const { unique, selected } = selectArticles(rows, 'TEST', 10);
  assert.equal(unique, 2);
  assert.ok(selected.some((r) => r.ts === 2) && !selected.some((r) => r.ts === 1));
});

test('when sampling, prefers focused articles and spreads picks across days', () => {
  const rows = [];
  let i = 0;
  // Day 0 is very noisy; days 1-3 are quiet. Two focused articles per day.
  for (let n = 0; n < 60; n++) rows.push(row(i++, { day: 0, symbolCount: n < 2 ? 1 : 25 }));
  for (const day of [1, 2, 3]) for (let n = 0; n < 5; n++) rows.push(row(i++, { day, symbolCount: n < 2 ? 1 : 25 }));

  const { selected } = selectArticles(rows, 'TEST', 8);
  assert.equal(selected.length, 8);
  const perDay = [0, 1, 2, 3].map((d) => selected.filter((r) => Math.floor(r.ts / DAY) === d).length);
  assert.deepEqual(perDay, [2, 2, 2, 2], 'every day represented equally');
  assert.ok(selected.every((r) => r.symbolCount === 1), 'only the focused articles were taken');
  assert.deepEqual([...selected].sort((a, b) => a.ts - b.ts), selected, 'returned oldest first');
});

test('a title naming the ticker outranks a passing mention', () => {
  const rows = [row(1, { title: 'Markets wrap: stocks mixed', symbolCount: 4 }), row(2, { title: 'Why TEST (NYSE:TEST) fell today', symbolCount: 4 })];
  const { selected } = selectArticles(rows, 'TEST', 1);
  assert.equal(selected[0].ts, 2);
});
