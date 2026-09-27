import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const REQUIRED = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'RUNPOD_VOLUME_ID',
  'RUNPOD_S3_REGION',
  'RUNPOD_S3_ENDPOINT',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  // Names only — never print values.
  throw new Error(`Missing required env vars: ${missing.join(', ')} (see .env.example)`);
}

// Serverless hosts ship a read-only bundle with only /tmp writable, and wipe it between
// cold starts. Defaulting there keeps the app from crashing on import; it does mean the
// article index starts empty on most requests (see api/index.js).
const defaultCacheDir = process.env.VERCEL ? '/tmp/news-reader-cache' : '.cache';
const cacheDir = path.resolve(rootDir, process.env.CACHE_DIR || defaultCacheDir);

// Atlas hands out connection strings with a "<db_password>" placeholder to fill in.
function mongoUri() {
  const uri = process.env.MONGO_URI;
  if (!uri) return null;
  const placeholder = /<(?:db_)?password>/i;
  if (!placeholder.test(uri)) return uri;
  if (!process.env.DB_PASSWORD) {
    throw new Error('MONGO_URI contains a <db_password> placeholder but DB_PASSWORD is not set (see .env.example)');
  }
  return uri.replace(placeholder, encodeURIComponent(process.env.DB_PASSWORD));
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  // Who may call this API from a browser on another origin. Empty (the default) sends no
  // CORS headers at all, which is what a loopback-only local tool wants: this API hands
  // out licensed vendor article text, so it must not be readable by any page the user
  // happens to have open. Set it only when the frontend is served from another origin.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  s3: {
    endpoint: process.env.RUNPOD_S3_ENDPOINT,
    region: process.env.RUNPOD_S3_REGION,
    bucket: process.env.RUNPOD_VOLUME_ID,
  },
  newsPrefix: 'data/news/',
  manifestKey: 'data/_run.json',
  cacheDir,
  dbPath: path.join(cacheDir, 'news.sqlite'),
  // How long ticker listings / object metadata are trusted before re-checking S3.
  listingTtlMs: 10 * 60 * 1000,
  headTtlMs: 5 * 60 * 1000,
  // Tail sync: first suffix read, and how far back we are willing to grow it.
  tailInitialBytes: 2 * 1024 * 1024,
  tailMaxBytes: 64 * 1024 * 1024,
  maxConcurrentFullSyncs: 2,
  // Optional: user preferences (pinned tickers) shared across browsers and devices.
  // Without MONGO_URI the pin endpoints answer 503 and the UI hides pinning.
  mongo: {
    uri: mongoUri(),
    dbName: process.env.MONGO_DB || 'news_reader',
    pinsCollection: 'pinned_tickers',
    connectTimeoutMs: 8000,
  },
  // Optional: article summaries. Without a key the summary endpoint answers 503.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    // Tried in order when the main model is overloaded (503) or out of quota (429; quotas
    // are per model). Defaults are Google's moving aliases, which cannot go stale the way
    // pinned model ids do. Comma-separated; "none" disables.
    fallbackModels: (process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-latest,gemini-flash-lite-latest')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m && m.toLowerCase() !== 'none'),
    timeoutMs: 60_000,
    maxArticleChars: 40_000,
  },
};
