import express from 'express';
import cors from 'cors';
import { api } from './routes.js';
import { config } from './config.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Off unless ALLOWED_ORIGINS names who may call us; "*" opens the API to every site.
  const { allowedOrigins } = config;
  if (allowedOrigins.length) {
    app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
  } else if (process.env.VERCEL) {
    // Deployed but same-origin-only: a separately hosted frontend will be blocked by the
    // browser with no clue in the response. Say so where the logs will show it.
    console.warn('[cors] ALLOWED_ORIGINS is unset — browser calls from any other origin will be blocked. Set it to the frontend origin, then redeploy.');
  }

  app.use('/api', api);

  // Hitting the base URL should say what this service is, not "Cannot GET /".
  app.get('/', (_req, res) => {
    res.json({
      service: 'ManualAnalysis news API',
      endpoints: [
        'GET  /api/health',
        'GET  /api/tickers',
        'GET  /api/tickers/:ticker/news?limit&before&q',
        'GET  /api/tickers/:ticker/sync   ·  POST /api/tickers/:ticker/sync',
        'GET  /api/tickers/:ticker/digest?from&to  ·  POST (same) ·  POST /api/tickers/:ticker/digest/ask',
        'GET  /api/news/:id  ·  POST /api/news/:id/summary?ticker  ·  POST /api/news/:id/ask?ticker',
        'GET  /api/pins  ·  PUT /api/pins/:ticker  ·  DELETE /api/pins/:ticker',
      ],
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express identifies error handlers by their four-argument signature.
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.$metadata ? 502 : 500); // $metadata => came from S3
    if (status >= 500) console.error(`[api] ${err.name}: ${err.message}`);
    res.status(status).json({ error: err.message });
  });

  return app;
}
