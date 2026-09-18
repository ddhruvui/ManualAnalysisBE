import { config } from './config.js';
import { createApp } from './app.js';
import { closePins } from './pins.js';

const app = createApp();

// Local tool: bind to loopback only so the API (and the vendor content behind it) is not
// exposed to the network.
app.listen(config.port, '127.0.0.1', () => {
  console.log(`News API listening on http://localhost:${config.port}`);
  console.log(`Volume ${config.s3.bucket} via ${config.s3.endpoint} (read-only) · index at ${config.dbPath}`);
});

// Let `node --watch` restarts and Ctrl-C exit promptly instead of waiting on Mongo sockets.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await closePins();
    process.exit(0);
  });
}
