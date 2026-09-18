// The list of tickers that have a news file, with sizes (from a cached S3 listing) and
// vendor article counts (from the small acquisition manifest, so no file is scanned).
import { config } from './config.js';
import * as db from './db.js';
import { getObjectJson, listObjects } from './s3.js';

let cache = null; // { at, tickers, manifest }
let inflight = null;

async function load() {
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
    at: Date.now(),
    tickers,
    manifest: manifest
      ? { vendor: manifest.vendor ?? null, endedAt: manifest.ended_at ?? null, newsFrom: manifest.news_from ?? null }
      : null,
  };
}

async function getCatalog() {
  if (cache && Date.now() - cache.at < config.listingTtlMs) return cache;
  inflight ??= load().finally(() => {
    inflight = null;
  });
  try {
    cache = await inflight;
  } catch (err) {
    if (!cache) throw err; // nothing to fall back to
    console.warn(`[catalog] refresh failed, serving stale listing: ${err.message}`);
  }
  return cache;
}

export async function listTickers() {
  const { tickers, manifest, at } = await getCatalog();
  const indexed = db.indexedCounts();
  const fullySynced = new Set(
    db.allFileStates().filter((f) => f.full_synced_at).map((f) => f.ticker),
  );
  return {
    source: manifest,
    listedAt: new Date(at).toISOString(),
    tickers: tickers.map((t) => ({
      ...t,
      indexedCount: indexed.get(t.ticker) ?? 0,
      fullyIndexed: fullySynced.has(t.ticker),
    })),
  };
}
