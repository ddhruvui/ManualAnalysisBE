# backend/ — Node API

Own git repo. Project-wide context lives one level up: **read `../CLAUDE.md` first**, then
`../docs/` as needed (data-layout, runpod-storage, architecture).

**Status (2026-09-18): empty — no package.json, no code yet.** Don't scaffold until asked.

## Role

Read news files from the RunPod volume through the S3-compatible API and serve them as
JSON to the React frontend. It is the only component that holds RunPod credentials.

## Rules specific to this repo

- **Read-only S3:** only `ListObjectsV2`, `HeadObject`, `GetObject`. No write/delete calls
  anywhere in this codebase, including scripts and tests.
- **Config comes from `.env`** (git-ignored; template in `.env.example`). Don't Read/print
  `.env`; add any new variable to `.env.example` and to the table in `../CLAUDE.md`.
- **Never load a whole news file into memory per request** — files reach 340 MB. Stream,
  Range-read, or serve from a local cache/index.
- Anything cached from the volume goes in git-ignored paths (`.cache/`, `data/`, `*.sqlite`)
  — it is licensed vendor content and must not be committed.
- Tests/fixtures use synthetic articles matching the schema in `../docs/data-layout.md`.

## Commands

None yet. When a package.json exists, record dev/start/test/lint commands here.
