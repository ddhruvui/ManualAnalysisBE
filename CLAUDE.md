# backend/ — Express news API

Own git repo. Project-wide context lives one level up: **read `../CLAUDE.md` first**, then
`../docs/` as needed (architecture = how sync/index/API work; runpod-storage = S3 gotchas;
data-layout = file schema).

## Role

Reads news files from the RunPod volume through the S3-compatible API (read-only), keeps
a lazy local SQLite index, and serves JSON to the React frontend. It is the only component
that holds RunPod credentials.

## Commands

```bash
npm run dev     # node --watch, http://localhost:4000 (loopback only)
npm start       # same without watch
npm test        # node:test, synthetic data only — no network
```

Requires Node ≥ 22.13 (built-in `node:sqlite`; scripts pass
`--disable-warning=ExperimentalWarning`). Plain JavaScript, ESM, 3 runtime deps
(express 5, @aws-sdk/client-s3, dotenv); Gemini is called with built-in `fetch`.

## Layout

```
src/config.js         env loading/validation (names only in errors), tunables
src/s3.js             READ-ONLY S3 client + RunPod trailing-slash middleware
src/objectScanner.js  byte-level scanner: streams huge JSON arrays object by object; parseTail()
src/db.js             all SQL (node:sqlite): schema, inserts, keyset paging, article IDs
src/sync.js           per-ticker tail sync + background full sync, job status
src/gemini.js         on-demand Gemini summary of one article for a focus ticker (fetch, no SDK, nothing stored)
src/catalog.js        ticker list = cached S3 listing + data/_run.json counts + index state
src/routes.js         /api routes + input validation
src/app.js, server.js Express wiring, error handler, listen on 127.0.0.1
test/                 node:test suites
.cache/               SQLite index (git-ignored, holds licensed content, safe to delete)
```

## Rules specific to this repo

- **Read-only S3:** only `ListObjectsV2`, `HeadObject`, `GetObject` — `src/s3.js` is the
  only file allowed to import from `@aws-sdk/client-s3`. No write/delete calls anywhere,
  including scripts and tests.
- **Config comes from `.env`** (git-ignored; template in `.env.example`). Don't Read/print
  `.env`; add any new variable to `.env.example` and to the table in `../CLAUDE.md`.
- **Gemini:** only `src/gemini.js` talks to Google, only when the summary endpoint is hit
  (user click). Key goes in the `x-goog-api-key` header — never in the URL or logs. Don't
  add bulk/background summarization or server-side storage of summaries without asking.
- **Never load a whole news file into memory** — files reach 340 MB. Use `ObjectScanner`
  on the stream, or `parseTail` on a suffix Range read.
- Keep all SQL inside `src/db.js` so the SQLite driver stays swappable. This SQLite build
  has **no FTS5**; `better-sqlite3` segfaulted on this machine (2026-09-18).
- Anything cached from the volume goes in git-ignored paths (`.cache/`, `data/`, `*.sqlite`).
- Tests/fixtures use synthetic articles matching the schema in `../docs/data-layout.md`.
- When testing against the live volume use a small ticker (AOS ≈ 5 MB).
