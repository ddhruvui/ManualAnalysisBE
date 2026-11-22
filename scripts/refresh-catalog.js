// Rebuild the ticker catalog from the RunPod volume and save it to MongoDB.
// Run daily by .github/workflows/refresh-catalog.yml; safe to run by hand too.
//
//   node scripts/refresh-catalog.js            refresh if it's ≥ 05:00 New York time and
//                                              not yet done today (what the cron calls)
//   node scripts/refresh-catalog.js --force    refresh now regardless of the time
//   node scripts/refresh-catalog.js --dry-run  build from the volume, print, save nothing
//
// Reads the volume only (one listing + data/_run.json). Prints counts, never secrets.
import { buildCatalog, readSnapshot, writeSnapshot } from '../src/catalogStore.js';
import { shouldRefresh } from '../src/catalogSchedule.js';
import { closeMongo, mongoEnabled, redactMongoError } from '../src/mongo.js';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const dryRun = args.has('--dry-run');

async function main() {
  if (!dryRun && !mongoEnabled()) throw new Error('MONGO_URI is not set — nowhere to save the catalog');

  if (!dryRun) {
    const previous = await readSnapshot();
    const decision = shouldRefresh(new Date(), previous?.builtAt ?? null, force);
    console.log(`[refresh-catalog] ${decision.run ? 'running' : 'skipping'}: ${decision.reason}`);
    if (!decision.run) return;
  }

  const started = performance.now();
  const catalog = await buildCatalog();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const articles = catalog.tickers.reduce((sum, t) => sum + (t.articleCount ?? 0), 0);
  console.log(
    `[refresh-catalog] built from the volume in ${seconds}s: ${catalog.tickers.length} tickers, ` +
      `${articles.toLocaleString('en-US')} articles per the manifest` +
      (catalog.source ? ` (manifest ended ${catalog.source.endedAt})` : ' (manifest unavailable)'),
  );

  if (dryRun) {
    console.log('[refresh-catalog] dry run — nothing saved');
    return;
  }
  await writeSnapshot(catalog);
  console.log(`[refresh-catalog] saved to MongoDB at ${catalog.builtAt.toISOString()}`);
}

try {
  await main();
} catch (err) {
  console.error(`[refresh-catalog] failed: ${redactMongoError(err)}`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
