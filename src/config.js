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

const cacheDir = path.resolve(rootDir, process.env.CACHE_DIR || '.cache');

export const config = {
  port: Number(process.env.PORT) || 4000,
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
};
