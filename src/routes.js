import { Router } from 'express';
import * as db from './db.js';
import { listTickers } from './catalog.js';
import { activeJobs, ensureTicker, forceFullSync, getStatus } from './sync.js';
import { headObject } from './s3.js';
import { config } from './config.js';

export const api = Router();

const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,14}$/;
const ARTICLE_ID_RE = /^[a-f0-9]{20}$/;
const CURSOR_RE = /^(-?\d+)_([a-f0-9]{20})$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// Tickers become part of an S3 key, so only accept a strict shape.
api.param('ticker', (req, _res, next, value) => {
  const ticker = String(value).toUpperCase();
  if (!TICKER_RE.test(ticker)) return next(badRequest('Invalid ticker'));
  req.ticker = ticker;
  next();
});

api.get('/health', async (_req, res) => {
  let volume;
  try {
    await headObject(config.manifestKey);
    volume = { reachable: true };
  } catch (err) {
    volume = { reachable: false, error: err.message };
  }
  res.json({ ok: volume.reachable, volume, index: db.totals(), activeSyncs: activeJobs() });
});

api.get('/tickers', async (_req, res) => {
  res.json(await listTickers());
});

api.get('/tickers/:ticker/news', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  let before = null;
  if (req.query.before !== undefined) {
    const m = CURSOR_RE.exec(String(req.query.before));
    if (!m) throw badRequest('Invalid cursor');
    before = { ts: Number(m[1]), id: m[2] };
  }

  // Only the first page triggers a freshness check; paging reads straight from the index.
  const sync = before ? getStatus(req.ticker) : await ensureTicker(req.ticker);
  const page = db.listHeadlines({ ticker: req.ticker, limit, before, q });
  res.json({ ticker: req.ticker, ...page, sync });
});

api.get('/tickers/:ticker/sync', (req, res) => {
  res.json(getStatus(req.ticker));
});

api.post('/tickers/:ticker/sync', async (req, res) => {
  res.status(202).json(await forceFullSync(req.ticker));
});

api.get('/news/:id', (req, res) => {
  if (!ARTICLE_ID_RE.test(req.params.id)) throw badRequest('Invalid article id');
  const article = db.getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found in the local index' });
  res.json(article);
});
