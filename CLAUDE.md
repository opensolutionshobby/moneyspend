# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — serve on `PORT` (default 8731), SQLite file from `LEVEL_DB` (default `./level.db`).
- `npm test` — `node --test test/*.test.js`. The glob matters: `node --test test/` fails with MODULE_NOT_FOUND on this Node version.
- No build step, no bundler, no framework. Client files are served as-is from `public/`.

## Hard constraints

- **Zero runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`, `node:test` only. Do not add packages — reach for a built-in or write it. `node:sqlite` prints an ExperimentalWarning on startup; that is expected, not a failure.
- **`public/ds.css` is vendored** from the Claude Design project (`_ds/modernist-…/styles.css`). Do not hand-edit it; app-specific CSS goes in `public/app.css`.
- **`settle()` and `ease()` in `public/app.js` are lifted verbatim** from the design doc's script block. Keep them byte-compatible so the app's numbers match the mockup.

## Money and quantities

Amounts are **integer hundredths** everywhere server-side (`amount_cents`), stored **per unit**; each item also has `qty` (1–999). A person's total is `Σ qty × amountCents`; the event total is the sum of those. Floats never reach the database.

There is **no currency** — numbers are bare, and trailing zeros are trimmed for display (`5000`, not `5000.00`; `15871.67` when a split needs it). `fmt()` in `app.js` and `fromCents()` in `store.js` both implement this; keep them in step.

## Server contract

Every mutation must, in this order: write → `bump` the event's `rev` → `broadcast(eventId, store.get(eventId))` → return the same full snapshot. `done()` in `server/api.js` does all of it; use it rather than hand-rolling a response. Clients drop any snapshot whose `rev` is not newer, so a mutation that skips the bump silently stops propagating.

Schema changes are **additive migrations** in `migrate()` (`server/db.js`) — `ALTER TABLE … ADD COLUMN … DEFAULT` guarded by a `PRAGMA table_info` check. Existing databases in the wild must keep opening.

Validation lives in `server/api.js` and rejects with 400 before touching the store; limits are in `LIMITS` (`server/db.js`). Writes are rate-limited per IP; tests set `LEVEL_RATE_LIMIT=off`.

## Client rules

- **Never `innerHTML` with server data.** Every render path uses `textContent` / `createElement`; that is what makes stored text inert.
- **Never overwrite a focused input.** Use `setValue()` in `app.js` — two people edit the same event at once.
- **Hold remote updates during the animation.** `run()` calls `store.setPaused(true)`; incoming snapshots queue until the blocks land, or the bars teleport mid-flight.
- Rows rebuild only when the set of person/item ids changes (`rowsSignature()`); otherwise values are refreshed in place, so typing survives.
- `localStorage` holds only visit records (`level.recent`, `[{id, at}]`) and the last name typed (`level.me`). Event data lives on the server.

## Layout

One DOM, two designs from the source mock: phone is option 1a, `min-width: 1000px` is option 1c. On the phone `.rail { display: contents }` so its children reorder into the single column. Bar geometry (`geo()`) is computed in JS per breakpoint, so anything touching bar widths, gaps or the chart height must change there, not in CSS.

## Gotchas that cost time

- **Port already in use:** `pkill -f "node server.js"` is unreliable here. Kill by port: `lsof -ti tcp:8731 | xargs kill -9`. A stale server serving old code looks exactly like a broken route.
- **Headless screenshots:** `--virtual-time-budget` never expires on the event page, because the SSE stream is a request that never ends. Drive Chrome over the DevTools protocol (`--remote-debugging-port`) instead.
- A `Page.navigate`'d tab starts at the browser's default viewport, so evaluate layout only *after* setting `Emulation.setDeviceMetricsOverride`.

## Verifying UI work

Tests cover the API, not the screen. For anything visual or interactive, run the server and drive a real browser: two tabs on one event proves live sync, and the animation must be watched to the end (a backgrounded tab throttles `setTimeout` to ~1s, which slows it but does not break it).
