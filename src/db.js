// Local index of articles pulled from the volume. Lives in .cache/ (git-ignored):
// it holds licensed vendor content and can always be rebuilt from the volume.
//
// Uses Node's built-in SQLite so there is no native dependency. All SQL stays in this
// file, so swapping the driver later only touches this module.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.cacheDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  -- One row per unique article. The same article appears in many ticker files on the
  -- volume; it is stored once here. "content" is deliberately the last column so
  -- headline queries never have to touch its overflow pages.
  CREATE TABLE IF NOT EXISTS articles (
    id       TEXT PRIMARY KEY,
    ts       INTEGER NOT NULL,
    date     TEXT NOT NULL,
    title    TEXT NOT NULL,
    link     TEXT,
    symbols  TEXT NOT NULL,
    tags     TEXT NOT NULL,
    polarity REAL,
    neg      REAL,
    neu      REAL,
    pos      REAL,
    content  TEXT NOT NULL
  );

  -- Which ticker files an article was found in, ordered for newest-first paging.
  CREATE TABLE IF NOT EXISTS ticker_articles (
    ticker     TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    article_id TEXT NOT NULL,
    PRIMARY KEY (ticker, ts, article_id)
  ) WITHOUT ROWID;

  -- Which version of each ticker file the index reflects.
  CREATE TABLE IF NOT EXISTS ticker_files (
    ticker         TEXT PRIMARY KEY,
    etag           TEXT,
    size           INTEGER,
    last_modified  TEXT,
    full_synced_at TEXT,
    checked_at     TEXT
  );
`);

const stmts = {
  insertArticle: db.prepare(`
    INSERT INTO articles (id, ts, date, title, link, symbols, tags, polarity, neg, neu, pos, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `),
  linkTicker: db.prepare(
    'INSERT OR IGNORE INTO ticker_articles (ticker, ts, article_id) VALUES (?, ?, ?)',
  ),
  getArticle: db.prepare('SELECT * FROM articles WHERE id = ?'),
  countTicker: db.prepare('SELECT COUNT(*) AS n FROM ticker_articles WHERE ticker = ?'),
  getFile: db.prepare('SELECT * FROM ticker_files WHERE ticker = ?'),
  allFiles: db.prepare('SELECT * FROM ticker_files'),
  upsertFile: db.prepare(`
    INSERT INTO ticker_files (ticker, etag, size, last_modified, full_synced_at, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      etag = excluded.etag,
      size = excluded.size,
      last_modified = excluded.last_modified,
      full_synced_at = COALESCE(excluded.full_synced_at, ticker_files.full_synced_at),
      checked_at = excluded.checked_at
  `),
  indexedCounts: db.prepare('SELECT ticker, COUNT(*) AS n FROM ticker_articles GROUP BY ticker'),
  totals: db.prepare('SELECT (SELECT COUNT(*) FROM articles) AS articles, (SELECT COUNT(*) FROM ticker_articles) AS links'),
};

const HEADLINE_COLUMNS = `
  a.id, a.ts, a.date, a.title, a.link, a.symbols, a.tags, a.polarity, a.neg, a.neu, a.pos,
  substr(a.content, 1, 280) AS snippet
`;

/** The data has no article ID, so derive a stable one that is identical across ticker files. */
export function articleId(raw) {
  return createHash('sha1')
    .update(`${raw.link ?? ''}|${raw.date ?? ''}|${raw.title ?? ''}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * Insert raw vendor articles for a ticker. Returns how many were new for this ticker and
 * how many it already had (the overlap is how tail sync knows it has caught up).
 */
export function insertArticles(ticker, rawArticles) {
  let added = 0;
  let existing = 0;
  if (!rawArticles.length) return { added, existing };
  db.exec('BEGIN');
  try {
    for (const raw of rawArticles) {
      if (!raw || typeof raw !== 'object' || !raw.date || !raw.title) continue;
      const id = articleId(raw);
      const ts = Date.parse(raw.date) || 0;
      const s = raw.sentiment ?? {};
      stmts.insertArticle.run(
        id,
        ts,
        String(raw.date),
        String(raw.title),
        raw.link ?? null,
        JSON.stringify(Array.isArray(raw.symbols) ? raw.symbols : []),
        JSON.stringify(Array.isArray(raw.tags) ? raw.tags : []),
        s.polarity ?? null,
        s.neg ?? null,
        s.neu ?? null,
        s.pos ?? null,
        String(raw.content ?? ''),
      );
      const { changes } = stmts.linkTicker.run(ticker, ts, id);
      if (changes) added++;
      else existing++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, existing };
}

function toHeadline(row) {
  const hasSentiment = row.polarity !== null;
  return {
    id: row.id,
    cursor: `${row.ts}_${row.id}`, // pass as ?before= to page older than this article
    date: row.date,
    title: row.title,
    link: row.link,
    symbols: JSON.parse(row.symbols),
    tags: JSON.parse(row.tags),
    sentiment: hasSentiment
      ? { polarity: row.polarity, neg: row.neg, neu: row.neu, pos: row.pos }
      : null,
    ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
    ...(row.content !== undefined ? { content: row.content } : {}),
  };
}

/** Newest-first page of headlines. `before` is the cursor returned by the previous page. */
export function listHeadlines({ ticker, limit, before, q }) {
  const where = ['ta.ticker = ?'];
  const params = [ticker];
  if (before) {
    where.push('(ta.ts, ta.article_id) < (?, ?)');
    params.push(before.ts, before.id);
  }
  if (q) {
    where.push("a.title LIKE ? ESCAPE '\\'");
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const rows = db
    .prepare(
      `SELECT ${HEADLINE_COLUMNS}
       FROM ticker_articles ta JOIN articles a ON a.id = ta.article_id
       WHERE ${where.join(' AND ')}
       ORDER BY ta.ts DESC, ta.article_id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toHeadline);
  return { items, nextCursor: hasMore ? items.at(-1).cursor : null };
}

/** Light rows (no article text) for every article of a ticker in [fromTs, toTs), oldest first. */
export function listLightInRange(ticker, fromTs, toTs) {
  return db
    .prepare(
      `SELECT a.id, a.ts, a.date, a.title, a.polarity, json_array_length(a.symbols) AS symbolCount
       FROM ticker_articles ta JOIN articles a ON a.id = ta.article_id
       WHERE ta.ticker = ? AND ta.ts >= ? AND ta.ts < ?
       ORDER BY ta.ts ASC, ta.article_id ASC`,
    )
    .all(ticker, fromTs, toTs);
}

/** First `chars` characters of the text of the given articles, as Map(id -> text). */
export function getContentSnippets(ids, chars) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .prepare(`SELECT id, substr(content, 1, ?) AS text FROM articles WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(chars, ...chunk);
    for (const r of rows) out.set(r.id, r.text);
  }
  return out;
}

export function getArticle(id) {
  const row = stmts.getArticle.get(id);
  return row ? toHeadline(row) : null;
}

export function countForTicker(ticker) {
  return stmts.countTicker.get(ticker).n;
}

export function getFileState(ticker) {
  return stmts.getFile.get(ticker) ?? null;
}

export function allFileStates() {
  return stmts.allFiles.all();
}

export function indexedCounts() {
  return new Map(stmts.indexedCounts.all().map((r) => [r.ticker, r.n]));
}

export function saveFileState(ticker, { etag, size, lastModified, fullSynced = false }) {
  const now = new Date().toISOString();
  stmts.upsertFile.run(ticker, etag, size, lastModified, fullSynced ? now : null, now);
}

export function totals() {
  const t = stmts.totals.get();
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(config.dbPath).size;
  } catch {
    // stats are best-effort
  }
  return { uniqueArticles: t.articles, tickerLinks: t.links, dbBytes };
}
