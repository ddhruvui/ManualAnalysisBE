// Keeps the local index in step with the ticker files on the volume, lazily per ticker:
//
//  1. Tail sync (awaited, fast): newest articles sit at the END of each file, so a suffix
//     Range read yields the latest headlines immediately — even for 340 MB files. If the
//     ticker was fully indexed before, overlapping with known articles means "caught up".
//  2. Full sync (background): the first time a ticker is opened, its whole file is
//     streamed into the index so older history becomes pageable. Progress is pollable.
import { config } from './config.js';
import * as db from './db.js';
import { getObjectStream, getObjectTail, headObject, isNotFound } from './s3.js';
import { ObjectScanner, parseTail } from './objectScanner.js';

const BATCH_SIZE = 500;

const jobs = new Map(); // ticker -> job
const headCache = new Map(); // ticker -> { at, head }

export class TickerNotFoundError extends Error {
  constructor(ticker) {
    super(`No news file for ticker "${ticker}"`);
    this.status = 404;
  }
}

const keyFor = (ticker) => `${config.newsPrefix}${ticker}.json`;
const isActive = (job) => job && ['tail', 'queued', 'full'].includes(job.phase);

async function cachedHead(ticker) {
  const hit = headCache.get(ticker);
  if (hit && Date.now() - hit.at < config.headTtlMs) return hit.head;
  try {
    const head = await headObject(keyFor(ticker));
    headCache.set(ticker, { at: Date.now(), head });
    return head;
  } catch (err) {
    if (isNotFound(err)) throw new TickerNotFoundError(ticker);
    throw err;
  }
}

// --- small semaphore so several big downloads don't run at once -------------------
let running = 0;
const waiting = [];
async function withFullSyncSlot(fn) {
  if (running >= config.maxConcurrentFullSyncs) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Returns true when the index is known to be complete for this file version. */
async function tailSync(job, head, state) {
  const key = keyFor(job.ticker);
  const wasFullyIndexed = Boolean(state?.full_synced_at);
  let bytes = config.tailInitialBytes;
  for (;;) {
    const n = Math.min(bytes, head.size);
    const wholeFile = n >= head.size;
    const articles = parseTail(await getObjectTail(key, n), { reachedStart: wholeFile });
    const { added, existing } = db.insertArticles(job.ticker, articles);
    job.added += added;
    if (wholeFile) return true;
    if (!wasFullyIndexed) return false; // first visit: history comes from the full sync
    if (existing > 0) return true; // reached articles we already had
    if (bytes >= config.tailMaxBytes) return false; // too far behind — do a full pass
    bytes *= 4;
  }
}

async function fullSync(job) {
  const { body, etag, size, lastModified } = await getObjectStream(keyFor(job.ticker));
  job.phase = 'full';
  job.totalBytes = size;
  job.bytesRead = 0;

  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    job.added += db.insertArticles(job.ticker, batch).added;
    job.articlesSeen += batch.length;
    batch = [];
  };
  const scanner = new ObjectScanner((article) => batch.push(article));

  for await (const chunk of body) {
    scanner.push(chunk);
    job.bytesRead += chunk.length;
    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  if (scanner.incomplete) {
    throw new Error('Download ended mid-article (the file may be mid-rewrite by the nightly job). Try again later.');
  }
  db.saveFileState(job.ticker, { etag, size, lastModified, fullSynced: true });
}

function startJob(ticker, head, state, { forceFull = false } = {}) {
  const job = {
    ticker,
    phase: 'tail',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    bytesRead: 0,
    totalBytes: head.size,
    articlesSeen: 0,
    added: 0,
    error: null,
  };
  jobs.set(ticker, job);

  const fail = (err) => {
    job.phase = 'error';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    headCache.delete(ticker);
    console.error(`[sync] ${ticker} failed: ${err.message}`);
  };
  const finish = () => {
    job.phase = 'done';
    job.finishedAt = new Date().toISOString();
  };

  // Resolves once the latest articles are queryable; never rejects.
  job.tailDone = (async () => {
    const complete = await tailSync(job, head, state);
    if (complete && !forceFull) {
      db.saveFileState(ticker, { ...head, fullSynced: true });
      finish();
      return;
    }
    job.phase = 'queued';
    job.fullDone = withFullSyncSlot(() => fullSync(job)).then(finish, fail);
  })().catch(fail);

  return job;
}

/**
 * Make sure the newest articles of a ticker are in the index (waits for the tail sync
 * only), kicking off a background full sync when needed. Returns the sync status.
 */
export async function ensureTicker(ticker) {
  if (isActive(jobs.get(ticker))) {
    await jobs.get(ticker).tailDone;
    return getStatus(ticker);
  }
  let head;
  try {
    head = await cachedHead(ticker);
  } catch (err) {
    // Volume unreachable: still serve whatever is already indexed.
    if (err instanceof TickerNotFoundError || db.countForTicker(ticker) === 0) throw err;
    return { ...getStatus(ticker), state: 'offline', error: err.message };
  }
  const state = db.getFileState(ticker);
  const upToDate = state?.full_synced_at && state.etag === head.etag;
  if (!upToDate) await startJob(ticker, head, state).tailDone;
  return getStatus(ticker);
}

/** Re-read the whole file regardless of what the index believes. */
export async function forceFullSync(ticker) {
  if (isActive(jobs.get(ticker))) return getStatus(ticker);
  headCache.delete(ticker);
  const head = await cachedHead(ticker);
  await startJob(ticker, head, db.getFileState(ticker), { forceFull: true }).tailDone;
  return getStatus(ticker);
}

export function getStatus(ticker) {
  const job = jobs.get(ticker);
  const state = db.getFileState(ticker);
  const indexedCount = db.countForTicker(ticker);

  let status;
  if (isActive(job)) status = job.phase === 'tail' ? 'syncing' : job.phase === 'queued' ? 'queued' : 'syncing';
  else if (job?.phase === 'error') status = 'error';
  else if (state?.full_synced_at) status = 'ready';
  else status = indexedCount > 0 ? 'partial' : 'not_indexed';

  return {
    ticker,
    state: status,
    indexedCount,
    fullSyncedAt: state?.full_synced_at ?? null,
    fileLastModified: state?.last_modified ?? null,
    progress:
      isActive(job) && job.phase === 'full'
        ? { bytesRead: job.bytesRead, totalBytes: job.totalBytes, articlesSeen: job.articlesSeen }
        : null,
    error: job?.phase === 'error' ? job.error : null,
  };
}

export function activeJobs() {
  return [...jobs.values()].filter(isActive).map((j) => j.ticker);
}
