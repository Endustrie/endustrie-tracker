# Endustrie Tracker

Encrypted, offline-first music production tracker. Runs as a PWA at
**https://endustrie.github.io/endustrie-tracker/** — installable on phone and desktop, works offline.

This repo contains **no user data**. The app ships empty; on first run you import your tracker
spreadsheet (songs, artists, contacts, social, campaigns) or start from scratch. Everything you
enter is encrypted on-device.

## Features

- **Song catalog** with explicit pipeline stages (Writing → Recorded → Mixing → Exported →
  Mastered → Video), album artwork, search/filter/sort, inline audio playback from a linked
  folder (Chromium).
- **Work queue** derived from the catalog — marking a task done updates the song itself. Undo
  everywhere (Cmd/Ctrl+Z, 40 levels).
- **Album sequencing** with drag-and-drop and running total length.
- **Finance**: quarterly revenue grid, Concur-style expense reports (line items, receipt photos,
  Draft → Submitted → Approved), monthly spend chart, dashboard P&L.
- **Spreadsheet import**: built-in .xlsx reader (zip/XML, zero dependencies) that fills all five
  data sets and picks up the album title.

## Security model

- Per-profile random 256-bit master key, wrapped by a passphrase-derived KEK
  (PBKDF2-SHA256 · 150k iterations → AES-256-GCM). All data — including artwork and receipts —
  is ciphertext at rest in IndexedDB.
- Optional **Touch ID / passkey unlock** (WebAuthn PRF) wrapping the same master key.
- Auto-lock on inactivity, unlock-attempt throttling, 8+ character passphrases.
- Encrypted backup files (restorable from the lock screen with the passphrase), plus explicit
  plaintext exports behind a warning.
- **No recovery**: a forgotten passphrase means unreadable data. Keep an encrypted backup.

## Sync (end-to-end encrypted)

Optional sync via Supabase (`schema.sql`): the client uploads only ciphertext under a random
128-bit Sync ID presented in the `X-Sync-Id` header; RLS makes rows invisible without the ID.
The server never sees names, emails, or readable content.

- The last **10 versions** are kept — Settings → Version history restores any of them.
- Attachments (artwork, receipts) sync as individually encrypted, content-addressed blobs.
- To connect a phone or second computer: **Restore from sync** + Sync ID + passphrase.
- Disabling sync deletes everything server-side.

## Development

```sh
npm install
npm run dev           # local dev server
npm test              # vitest suite (crypto, migration, xlsx parser, sync pruning)
npm run build         # PWA build for GitHub Pages (dist/)
npm run build:single  # self-contained single-file build (dist-single/index.html)
```

Pushes to `main` run tests and deploy to GitHub Pages via `.github/workflows/deploy.yml`.
The single-file build is for running directly from disk (double-click `index.html`); profiles
created there and on the hosted app are separate origins — use sync to bridge them.
