// The ticker catalog: which tickers have a news file, their sizes (S3 listing) and vendor
// article counts (data/_run.json). No article content — 517 small rows, ~70 KB.
//
// buildCatalog() asks the volume (slow on a cold start: a full listing plus the manifest).
// A daily GitHub Action (.github/workflows/refresh-catalog.yml → scripts/refresh-catalog.js)
// saves the result to MongoDB as one document, so /api/tickers can answer from Atlas
// without touching RunPod. Deliberately free of SQLite so the job needs no cache dir.
import { config } from './config.js';
import { mongoDb } from './mongo.js';
import { getObjectJson, listObjects } from './s3.js';

const SNAPSHOT_ID = 'news';

/** Build the catalog from the volume (read-only: one listing + one small GET). */
export async function buildCatalog() {
  const [objects, manifest] = await Promise.all([
    listObjects(config.newsPrefix),
    // Counts are a nicety — the app works without the manifest.
    getObjectJson(config.manifestKey).catch((err) => {
      console.warn(`[catalog] manifest unavailable: ${err.message}`);
      return null;
    }),
  ]);

  const counts = new Map();
  for (const r of manifest?.results ?? []) {
    if (r.dataset !== 'news' || typeof r.symbol !== 'string') continue;
    const dot = r.symbol.lastIndexOf('.');
    counts.set(dot === -1 ? r.symbol : r.symbol.slice(0, dot), r.count ?? null);
  }

  const tickers = objects
    .filter((o) => o.key.endsWith('.json'))
    .map((o) => {
      const ticker = o.key.slice(config.newsPrefix.length, -'.json'.length);
      return {
        ticker,
        articleCount: counts.get(ticker) ?? null,
        fileSize: o.size,
        lastModified: o.lastModified,
      };
    })
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  return {
    builtAt: new Date(),
    tickers,
    source: manifest
      ? { vendor: manifest.vendor ?? null, endedAt: manifest.ended_at ?? null, newsFrom: manifest.news_from ?? null }
      : null,
  };
}

const collection = async () => (await mongoDb()).collection(config.mongo.catalogCollection);

/** The saved catalog, or null if none has been written yet. Throws if Mongo is unreachable. */
export async function readSnapshot() {
  const doc = await (await collection()).findOne({ _id: SNAPSHOT_ID });
  if (!doc || !Array.isArray(doc.tickers) || !doc.tickers.length) return null;
  return { builtAt: new Date(doc.builtAt), tickers: doc.tickers, source: doc.source ?? null };
}

/** Replace the saved catalog (one document, so readers never see a half-written list). */
export async function writeSnapshot(catalog) {
  if (!catalog.tickers.length) throw new Error('Refusing to save an empty ticker catalog');
  await (await collection()).replaceOne(
    { _id: SNAPSHOT_ID },
    { builtAt: catalog.builtAt, source: catalog.source, tickers: catalog.tickers },
    { upsert: true },
  );
}
