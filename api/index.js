// Vercel entry point. The platform invokes this exported app per request, so there is no
// listen() here — src/server.js keeps that for local runs.
//
// Caveat worth knowing before relying on this deployment: the article index is a SQLite
// file, and a serverless instance only has ephemeral /tmp. Pins (MongoDB Atlas), health,
// the ticker list and the newest headlines per ticker (fetched from the volume on demand)
// work. Anything that needs the full history — older pages, opening an article the
// instance did not just fetch, day digests — needs the persistent index this host cannot
// provide. Run the backend on a host with a disk for the whole app.
import { createApp } from '../src/app.js';

export default createApp();
