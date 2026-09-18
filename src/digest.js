// Period digests: one Gemini call that summarizes a ticker's news flow over a day, week,
// month or quarter. Big tickers have thousands of articles per quarter (far beyond any
// sensible prompt), so the digest reads as much as fits in a fixed character budget:
// everything in full for quiet tickers, and for busy ones the most ticker-focused articles,
// spread evenly across the period, trimmed to their lead text.
//
// Like article summaries: on demand only, nothing stored.
import * as db from './db.js';
import { GROUND_RULES, generate, tidyPlainText } from './gemini.js';

export const DIGEST_LIMITS = {
  maxArticles: 400,
  charBudget: 260_000, // ≈ 65k tokens of article text per digest
  minCharsPerArticle: 350,
  maxCharsPerArticle: 6000,
  maxRangeDays: 100,
  timeoutMs: 150_000,
};

export const PERIODS = ['day', 'week', 'month', 'quarter'];

const DAY_MS = 86_400_000;

const normalizeTitle = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Higher = more likely to really be about the ticker rather than a passing mention. */
function focusScore(row, ticker) {
  const mentionsTicker = new RegExp(`(^|[^A-Za-z])${ticker.replace(/[^A-Z0-9]/g, '\\$&')}([^A-Za-z]|$)`).test(row.title);
  return 1 / Math.max(1, row.symbolCount ?? 1) + (mentionsTicker ? 0.5 : 0);
}

/**
 * Choose which articles a digest reads. Syndicated duplicates (same title) are dropped;
 * if more than `max` remain, take the most focused ones round-robin across days so one
 * noisy day cannot crowd out the rest of the period. Returns rows oldest-first.
 */
export function selectArticles(rows, ticker, max = DIGEST_LIMITS.maxArticles) {
  const byTitle = new Map();
  for (const row of rows) {
    const scored = { ...row, score: focusScore(row, ticker) };
    const key = normalizeTitle(row.title) || row.id;
    const seen = byTitle.get(key);
    if (!seen || scored.score > seen.score) byTitle.set(key, scored);
  }
  const unique = [...byTitle.values()];
  if (unique.length <= max) return { unique: unique.length, selected: unique.sort((a, b) => a.ts - b.ts) };

  const days = new Map();
  for (const row of unique) {
    const day = Math.floor(row.ts / DAY_MS);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(row);
  }
  const buckets = [...days.values()].map((bucket) => bucket.sort((a, b) => b.score - a.score));

  const selected = [];
  for (let rank = 0; selected.length < max; rank++) {
    const round = buckets.filter((b) => b.length > rank).map((b) => b[rank]);
    if (!round.length) break;
    const room = max - selected.length;
    // A partial last round goes to the best candidates, not to whichever days come first.
    selected.push(...(round.length > room ? round.sort((a, b) => b.score - a.score).slice(0, room) : round));
  }
  return { unique: unique.length, selected: selected.sort((a, b) => a.ts - b.ts) };
}

function charsPerArticle(count) {
  const { charBudget, minCharsPerArticle, maxCharsPerArticle } = DIGEST_LIMITS;
  if (!count) return 0;
  return Math.min(maxCharsPerArticle, Math.max(minCharsPerArticle, Math.floor(charBudget / count)));
}

/** What a digest for this range would read — no Gemini call. */
export function planDigest(ticker, fromTs, toTs) {
  const rows = db.listLightInRange(ticker, fromTs, toTs);
  const { unique, selected } = selectArticles(rows, ticker);
  return {
    rows: selected,
    plan: {
      articleCount: rows.length,
      uniqueCount: unique,
      usedCount: selected.length,
      charsPerArticle: charsPerArticle(selected.length),
      sampled: selected.length < unique,
    },
  };
}

const DIGEST_INSTRUCTION = `You are an equity research assistant. An analyst follows ONE focus stock and wants a digest of its news flow over a period (a day, week, month or quarter).

You receive a numbered list of articles from that period: date, vendor sentiment, how many symbols the vendor tagged (many tags = the focus ticker is probably a passing mention), title, and the beginning of the text (often truncated). For busy tickers the list is a sample of the most ticker-focused articles, so do not read anything into the raw number of articles.

Write the digest from the point of view of someone who only cares about the focus ticker:
- Lead with what actually mattered for the stock in this period.
- Group the news into a few themes. Separate company-specific developments from market / macro / sector drivers, and for the latter explain the channel to the focus ticker.
- List dated key events only when the articles support a specific date.
- Ignore articles that are not really about the focus ticker. If coverage is thin or mostly passing mentions, say so plainly.
- Cite your sources: in articleRefs give the [n] numbers of the articles that support each theme or event (the 1-6 most relevant).

Rules:
${GROUND_RULES}
- Longer periods deserve more synthesis, not more length: themes over play-by-play.`;

const DIRECTION = ['positive', 'negative', 'mixed', 'neutral'];
const refs = { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Numbers [n] of the supporting articles.' };

const DIGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One sentence: the main takeaway for the focus ticker this period.' },
    tone: { type: 'STRING', enum: DIRECTION, description: 'Overall tone of the news flow for the focus ticker.' },
    overview: { type: 'STRING', description: '3-5 sentences tying the period together.' },
    themes: {
      type: 'ARRAY',
      description: '2-6 themes, most important first.',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          direction: { type: 'STRING', enum: DIRECTION },
          summary: { type: 'STRING', description: '2-4 sentences.' },
          articleRefs: refs,
        },
        required: ['title', 'direction', 'summary', 'articleRefs'],
      },
    },
    keyEvents: {
      type: 'ARRAY',
      description: '0-8 dated events, oldest first. Empty if none are clearly dated.',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'YYYY-MM-DD' },
          event: { type: 'STRING' },
          articleRefs: refs,
        },
        required: ['date', 'event', 'articleRefs'],
      },
    },
    marketContext: { type: 'STRING', description: '1-3 sentences on market / sector forces and how they bear on the ticker. Empty string if none.' },
    watchNext: { type: 'ARRAY', items: { type: 'STRING' }, description: '2-4 things the articles suggest watching next.' },
    followUps: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Exactly 3 short follow-up questions (under 14 words each) the analyst might ask next about THIS digest: one asking what a finance term or claim in it means, one digging into the most important theme, one about implications for the focus ticker.',
    },
  },
  required: ['headline', 'tone', 'overview', 'themes', 'keyEvents', 'marketContext', 'watchNext', 'followUps'],
  propertyOrdering: ['headline', 'tone', 'overview', 'themes', 'keyEvents', 'marketContext', 'watchNext', 'followUps'],
};

const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function buildPrompt(ticker, period, fromTs, toTs, rows, snippets, plan) {
  const header = [
    `Focus ticker: ${ticker}`,
    `Period: ${period}, ${isoDay(fromTs)} to ${isoDay(toTs - 1)} (UTC dates)`,
    `Articles in the period: ${plan.articleCount} (${plan.uniqueCount} after removing duplicates). Listed below: ${plan.usedCount}${plan.sampled ? ' — a sample of the most ticker-focused, spread across the period' : ''}.`,
    '',
  ];
  const body = rows.map((row, i) => {
    const sentiment = row.polarity == null ? 'n/a' : (row.polarity > 0 ? '+' : '') + row.polarity.toFixed(2);
    return [
      `[${i + 1}] ${row.date.slice(0, 10)} | vendor sentiment ${sentiment} | tagged with ${row.symbolCount} symbols`,
      `Title: ${row.title}`,
      `Text: ${(snippets.get(row.id) ?? '').replace(/\s+/g, ' ').trim() || '(no text)'}`,
    ].join('\n');
  });
  return `${header.join('\n')}<articles>\n${body.join('\n\n')}\n</articles>`;
}

export async function createDigest(ticker, period, fromTs, toTs) {
  const { rows, plan } = planDigest(ticker, fromTs, toTs);
  if (!rows.length) return { ticker, period, from: fromTs, to: toTs, ...plan, empty: true };

  const snippets = db.getContentSnippets(rows.map((r) => r.id), plan.charsPerArticle);
  const { text: raw, model } = await generate({
    systemInstruction: DIGEST_INSTRUCTION,
    contents: [{ role: 'user', parts: [{ text: buildPrompt(ticker, period, fromTs, toTs, rows, snippets, plan) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: DIGEST_SCHEMA },
    timeoutMs: DIGEST_LIMITS.timeoutMs,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { overview: raw };
  }

  // Turn the model's [n] citations back into real articles; drop anything out of range.
  const sources = new Map();
  const resolve = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= rows.length)
      .slice(0, 6)
      .map((n) => {
        const row = rows[n - 1];
        sources.set(row.id, { id: row.id, title: row.title, date: row.date });
        return row.id;
      });

  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    ticker,
    period,
    from: fromTs,
    to: toTs,
    ...plan,
    model,
    headline: text(parsed.headline, 400),
    tone: DIRECTION.includes(parsed.tone) ? parsed.tone : null,
    overview: text(parsed.overview),
    themes: list(parsed.themes)
      .slice(0, 8)
      .map((t) => ({
        title: text(t?.title, 200),
        direction: DIRECTION.includes(t?.direction) ? t.direction : null,
        summary: text(t?.summary),
        articleIds: resolve(t?.articleRefs),
      }))
      .filter((t) => t.title || t.summary),
    keyEvents: list(parsed.keyEvents)
      .slice(0, 10)
      .map((e) => ({ date: text(e?.date, 10), event: text(e?.event, 600), articleIds: resolve(e?.articleRefs) }))
      .filter((e) => e.event),
    marketContext: text(parsed.marketContext),
    watchNext: list(parsed.watchNext).map((w) => text(w, 300)).filter(Boolean).slice(0, 5),
    followUps: list(parsed.followUps).map((q) => text(q, 200)).filter(Boolean).slice(0, 3),
    sources: Object.fromEntries(sources),
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Follow-up questions about a digest
// ---------------------------------------------------------------------------------------

const DIGEST_FOLLOW_UP_INSTRUCTION = `You are an equity research assistant. An analyst follows ONE focus stock. You were given a numbered list of that stock's news articles for a period and wrote a digest of them (your first turn). Now answer the analyst's follow-up questions.

- Answer from the articles. When they ask what a term or claim means, explain it in plain language first, then tie it to what the articles say about the focus ticker and why it matters for the stock.
- If the articles do not cover what they ask, say so plainly instead of guessing. Clearly label anything that is general background rather than something the articles say.
- You have no live data: no current prices and nothing that happened after the period.
- You may lay out considerations and what to watch, but do not tell them to buy or sell.
- In articleRefs give the [n] numbers of the articles your answer relies on (0-6). Do not write [n] markers inside the answer text.

Rules:
${GROUND_RULES}
- The answer is plain text only, no Markdown. Short paragraphs; "- " bullets are fine. Keep it under about 180 words unless they ask for more detail.`;

const DIGEST_ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: { answer: { type: 'STRING' }, articleRefs: refs },
  required: ['answer', 'articleRefs'],
  propertyOrdering: ['answer', 'articleRefs'],
};

/** The digest the user is looking at, replayed to the model as its own earlier turn. */
function digestAsModelTurn(digest) {
  const items = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const themes = items(digest?.themes, 8)
    .map((t) => `- ${text(t?.title, 200)} (${text(t?.direction, 20) || 'n/a'}): ${text(t?.summary)}`)
    .filter((line) => line.length > 12);
  const events = items(digest?.keyEvents, 10)
    .map((e) => `- ${text(e?.date, 10)}: ${text(e?.event, 600)}`)
    .filter((line) => line.length > 6);
  const watch = items(digest?.watchNext, 5).map((w) => `- ${text(w, 300)}`).filter((line) => line.length > 2);
  return [
    text(digest?.headline, 400),
    text(digest?.overview),
    themes.length ? `Themes:\n${themes.join('\n')}` : '',
    events.length ? `Key events:\n${events.join('\n')}` : '',
    text(digest?.marketContext) && `Market context: ${text(digest.marketContext)}`,
    watch.length ? `What to watch next:\n${watch.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Answer a follow-up question about a period digest. Stateless like everything else here:
 * the article list is rebuilt from the index for the same range (so it costs about as
 * much as the digest itself — Gemini's implicit prefix caching softens that), `digest` is
 * the digest object the user was shown, and `messages` is the whole thread so far.
 */
export async function answerDigestFollowUp(ticker, period, fromTs, toTs, { digest, messages }) {
  const { rows, plan } = planDigest(ticker, fromTs, toTs);
  if (!rows.length) return { answer: 'There are no articles in this period to answer from.', sources: [], model: null, generatedAt: new Date().toISOString() };

  const snippets = db.getContentSnippets(rows.map((r) => r.id), plan.charsPerArticle);
  const { text: raw, model } = await generate({
    systemInstruction: DIGEST_FOLLOW_UP_INSTRUCTION,
    contents: [
      { role: 'user', parts: [{ text: `${buildPrompt(ticker, period, fromTs, toTs, rows, snippets, plan)}\n\nWrite the digest for the focus ticker.` }] },
      { role: 'model', parts: [{ text: digestAsModelTurn(digest) || '(digest unavailable)' }] },
      ...messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    ],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: DIGEST_ANSWER_SCHEMA },
    timeoutMs: DIGEST_LIMITS.timeoutMs,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { answer: raw, articleRefs: [] };
  }

  const seen = new Set();
  const sources = (Array.isArray(parsed.articleRefs) ? parsed.articleRefs : [])
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= rows.length && !seen.has(n) && seen.add(n))
    .slice(0, 6)
    .map((n) => ({ id: rows[n - 1].id, title: rows[n - 1].title, date: rows[n - 1].date }));

  return { answer: tidyPlainText(text(parsed.answer, 6000)), sources, model, generatedAt: new Date().toISOString() };
}
