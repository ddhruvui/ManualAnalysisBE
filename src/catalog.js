// The ticker list served by /api/tickers.
//
// Normally it comes from the snapshot a daily GitHub Action saves in MongoDB (see
// catalogStore.js), so the landing page never waits on RunPod — a cold listing of the
// volume once took 33 s on Vercel. Only when that snapshot is unavailable (no MONGO_URI,
// Atlas unreachable, or never written) is the catalog built live from the volume.
// Per-instance index state (SQLite) is added at request time; it never goes to Mongo.
import { config } from './config.js';
import * as db from './db.js';
import { buildCatalog, readSnapshot } from './catalogStore.js';
import { mongoEnabled, redactMongoError } from './mongo.js';

let cache = null; // { at, builtAt, tickers, source, origin }
let inflight = null;

async function load() {
  if (mongoEnabled()) {
    try {
      const snapshot = await readSnapshot();
      if (snapshot) return { at: Date.now(), ...snapshot, origin: 'snapshot' };
      console.warn('[catalog] no snapshot in MongoDB yet — listing the volume (run scripts/refresh-catalog.js to seed it)');
    } catch (err) {
      console.warn(`[catalog] snapshot unavailable, listing the volume instead: ${redactMongoError(err)}`);
    }
  }
  return { at: Date.now(), ...(await buildCatalog()), origin: 'volume' };
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
    console.warn(`[catalog] refresh failed, serving the previous list: ${err.message}`);
  }
  return cache;
}

export async function listTickers() {
  const { tickers, source, builtAt, origin } = await getCatalog();
  const indexed = db.indexedCounts();
  const fullySynced = new Set(
    db.allFileStates().filter((f) => f.full_synced_at).map((f) => f.ticker),
  );
  return {
    source,
    listedAt: builtAt.toISOString(),
    catalogOrigin: origin, // "snapshot" (MongoDB, daily) or "volume" (live fallback)
    tickers: tickers.map((t) => ({
      ...t,
      indexedCount: indexed.get(t.ticker) ?? 0,
      fullyIndexed: fullySynced.has(t.ticker),
    })),
  };
}
