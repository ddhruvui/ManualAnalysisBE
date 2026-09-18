import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectScanner, parseTail } from '../src/objectScanner.js';

// Synthetic articles in the vendor's shape and byte format (Python json.dump separators).
function article(i, extra = {}) {
  return {
    date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00+00:00`,
    title: `Synthetic headline ${i}`,
    content: `Body ${i} with "quotes", braces { } [ ], a backslash \\ and unicode é — ok.\n\nSecond paragraph.`,
    link: `https://example.test/a/${i}`,
    symbols: ['TEST.US'],
    tags: ['SYNTHETIC'],
    sentiment: { polarity: 0.5, neg: 0.1, neu: 0.8, pos: 0.1 },
    ...extra,
  };
}

function pythonStyleJson(value) {
  // Mimic json.dump default separators: ", " between items and ": " after keys.
  if (Array.isArray(value)) return `[${value.map(pythonStyleJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pythonStyleJson(v)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

const articles = Array.from({ length: 40 }, (_, i) => article(i));
const file = Buffer.from(pythonStyleJson(articles), 'utf8');

test('scans a whole file delivered in one chunk', () => {
  const seen = [];
  const scanner = new ObjectScanner((o) => seen.push(o));
  scanner.push(file);
  assert.deepEqual(seen, articles);
  assert.equal(scanner.incomplete, false);
});

test('handles objects, strings and escapes split across tiny chunks', () => {
  for (const chunkSize of [1, 7, 64, 1000]) {
    const seen = [];
    const scanner = new ObjectScanner((o) => seen.push(o));
    for (let i = 0; i < file.length; i += chunkSize) scanner.push(file.subarray(i, i + chunkSize));
    assert.deepEqual(seen, articles, `chunkSize=${chunkSize}`);
  }
});

test('reports a truncated download', () => {
  const scanner = new ObjectScanner(() => {});
  scanner.push(file.subarray(0, file.length - 50));
  assert.equal(scanner.incomplete, true);
});

test('parseTail recovers the newest articles from a mid-file suffix', () => {
  const tail = file.subarray(file.length - 1500);
  const parsed = parseTail(tail);
  assert.ok(parsed.length >= 2, 'expected several whole articles in the tail');
  assert.deepEqual(parsed, articles.slice(-parsed.length));
});

test('parseTail is not fooled by boundary-like text inside article content', () => {
  const tricky = [
    article(1),
    article(2, { content: 'looks like a boundary }, {"date": "2000-01-01" } but is just text' }),
    article(3),
  ];
  const buf = Buffer.from(pythonStyleJson(tricky), 'utf8');
  // Start inside article 2's content, after its real opening boundary.
  const start = buf.indexOf('looks like');
  assert.deepEqual(parseTail(buf.subarray(start)), [tricky[2]]);
});

test('parseTail with reachedStart parses the entire small file', () => {
  assert.deepEqual(parseTail(file, { reachedStart: true }), articles);
});
