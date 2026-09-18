import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

// Local tool: bind to loopback only so the API (and the vendor content behind it) is not
// exposed to the network.
app.listen(config.port, '127.0.0.1', () => {
  console.log(`News API listening on http://localhost:${config.port}`);
  console.log(`Volume ${config.s3.bucket} via ${config.s3.endpoint} (read-only) · index at ${config.dbPath}`);
});
