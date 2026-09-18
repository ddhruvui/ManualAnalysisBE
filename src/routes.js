import express, { Router } from 'express';
import * as db from './db.js';
import { listTickers } from './catalog.js';
import { activeJobs, ensureTicker, forceFullSync, getStatus } from './sync.js';
import { headObject } from './s3.js';
import { FOLLOW_UP_LIMITS, answerFollowUp, summariesEnabled, summarizeArticle } from './gemini.js';
import { DIGEST_LIMITS, PERIODS, answerDigestFollowUp, createDigest, planDigest } from './digest.js';
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
  res.json({
    ok: volume.reachable,
    volume,
    index: db.totals(),
    activeSyncs: activeJobs(),
    summaries: { enabled: summariesEnabled(), model: summariesEnabled() ? config.gemini.model : null },
  });
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

// Summarize one article for a focus ticker. POST because every call is a billable request
// that sends the article text to Google; the result is returned, never stored.
api.post('/news/:id/summary', async (req, res) => {
  if (!ARTICLE_ID_RE.test(req.params.id)) throw badRequest('Invalid article id');
  const ticker = String(req.query.ticker ?? '').toUpperCase();
  if (!TICKER_RE.test(ticker)) throw badRequest('A valid ?ticker= is required');
  const article = db.getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found in the local index' });
  res.set('Cache-Control', 'no-store').json(await summarizeArticle(article, ticker));
});

function parseThread(messages) {
  const { maxMessages, maxQuestionChars, maxAnswerChars } = FOLLOW_UP_LIMITS;
  if (!Array.isArray(messages) || !messages.length) throw badRequest('messages must be a non-empty array');
  if (messages.length > maxMessages) throw badRequest(`This conversation is too long (max ${maxMessages} messages) — start a new one`);
  return messages.map((m, i) => {
    const role = i % 2 === 0 ? 'user' : 'model'; // strict alternation, starting with the user
    const text = typeof m?.text === 'string' ? m.text.trim() : '';
    if (m?.role !== role) throw badRequest('messages must alternate user / model, starting and ending with user');
    if (!text) throw badRequest('messages cannot be empty');
    if (text.length > (role === 'user' ? maxQuestionChars : maxAnswerChars)) throw badRequest('A message is too long');
    return { role, text };
  });
}

// Follow-up question about an article. Stateless like the summary: the frontend sends the
// summary it displayed plus the whole thread, ending with the new question.
api.post('/news/:id/ask', express.json({ limit: '200kb' }), async (req, res) => {
  if (!ARTICLE_ID_RE.test(req.params.id)) throw badRequest('Invalid article id');
  const ticker = String(req.query.ticker ?? '').toUpperCase();
  if (!TICKER_RE.test(ticker)) throw badRequest('A valid ?ticker= is required');
  const messages = parseThread(req.body?.messages);
  if (messages.length % 2 === 0) throw badRequest('The last message must be the user\'s question');
  const article = db.getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found in the local index' });
  const summary = req.body?.summary && typeof req.body.summary === 'object' ? req.body.summary : null;
  res.set('Cache-Control', 'no-store').json(await answerFollowUp(article, ticker, { summary, messages }));
});

function parseRange(query) {
  const from = Number(query.from);
  const to = Number(query.to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    throw badRequest('from and to must be epoch milliseconds with from < to');
  }
  if (to - from > DIGEST_LIMITS.maxRangeDays * 86_400_000) {
    throw badRequest(`A digest can cover at most ${DIGEST_LIMITS.maxRangeDays} days`);
  }
  return { from, to };
}

// What a digest of [from, to) would read — counts only, no Gemini call. The frontend
// computes the range so periods follow the user's local calendar.
api.get('/tickers/:ticker/digest', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const sync = await ensureTicker(req.ticker);
  res.json({ ticker: req.ticker, from, to, ...planDigest(req.ticker, from, to).plan, sync });
});

function parsePeriod(query) {
  const period = String(query.period ?? 'day');
  if (!PERIODS.includes(period)) throw badRequest(`period must be one of ${PERIODS.join(', ')}`);
  return period;
}

// Generate the digest: one billable Gemini call over many articles; never stored.
api.post('/tickers/:ticker/digest', async (req, res) => {
  const { from, to } = parseRange(req.query);
  res.set('Cache-Control', 'no-store').json(await createDigest(req.ticker, parsePeriod(req.query), from, to));
});

// Follow-up question about a digest. Stateless: the body carries the digest that was shown
// and the whole thread; the articles are re-read from the index for the same range.
api.post('/tickers/:ticker/digest/ask', express.json({ limit: '300kb' }), async (req, res) => {
  const { from, to } = parseRange(req.query);
  const period = parsePeriod(req.query);
  const messages = parseThread(req.body?.messages);
  if (messages.length % 2 === 0) throw badRequest('The last message must be the user\'s question');
  const digest = req.body?.digest && typeof req.body.digest === 'object' ? req.body.digest : null;
  res
    .set('Cache-Control', 'no-store')
    .json(await answerDigestFollowUp(req.ticker, period, from, to, { digest, messages }));
});
