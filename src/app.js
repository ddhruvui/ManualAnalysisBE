import express from 'express';
import { api } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', api);

  app.use('/api', (_req, res) => {
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
