# CanSettle — backend scaffold

## What's here
- `backend/src/engine/` — the pure calculation engine (unchanged from earlier)
- `backend/src/store/` — data layer with two interchangeable implementations:
  - `inMemoryStore.mjs` — for local dev/testing, no external DB needed
  - `supabaseStore.mjs` — the real thing, once your Supabase project is set up
  - `index.mjs` — picks one based on the `STORE` env var (`memory` or anything else)
- `backend/src/settlementService.mjs` — glues a session's stored data into the engine, and refuses to settle (naming exactly what's unresolved) if anything's unassigned or a bill doesn't reconcile
- `backend/src/server.mjs` — the Express API
- `backend/src/server.test.mjs` — end-to-end test hitting the real HTTP routes
- `backend/db/schema.sql` — paste into Supabase's SQL editor to create the tables
- `backend/src/engine/copy.mjs` — a copy-strings module I found already in the folder when I got here (see note below)

## Running it
```
cd backend
npm install
cp .env.example .env      # then fill in SUPABASE_URL / SUPABASE_ANON_KEY once you have them
npm test                  # runs against the in-memory store, no DB needed
npm run dev                # starts the API on :3000
```

## Setting up Supabase (once you're ready to move off the in-memory store)
1. In the Supabase dashboard: New project → name it, pick a region, set a DB password.
2. SQL Editor → paste in `db/schema.sql` → Run.
3. Project Settings → API → copy the Project URL and anon public key into `.env`.
4. Set `STORE=supabase` (anything other than `memory`) in `.env`.

## API surface so far
- `POST /sessions` `{ label? }`
- `GET /sessions/:id`
- `POST /sessions/:id/participants` `{ name, telegramUserId? }`
- `POST /sessions/:id/bills` `{ source, payerId, serviceChargeCents?, gstCents?, totalCents, items: [{name, totalCents, quantity?}] }`
- `PATCH /sessions/:id/items/:itemId/allocation` `{ participantIds: [...] }`
- `GET /sessions/:id/settlement` → `{ ok:false, reason:'unassigned_items', unassignedItems }` or `{ ok:true, balances, transfers, billResults }`

## Not built yet
- Item claims (Mode B) — the `item_claims` table exists in the schema but there's no route for it yet
- Receipt OCR extraction
- Telegram bot layer
- Auth/session-token access control (right now anyone with a session id can read/write it - fine for a prototype, not for anything real)

## Note on copy.mjs
When I scaffolded this folder, `src/engine/copy.mjs` was already sitting there with the microcopy we'd drafted earlier turned into code - I didn't create it this turn, just found it. Content's fine (matches what we discussed), just flagging it since I didn't write it myself. It's also arguably in the wrong folder - copy strings living inside `engine/` (which is supposed to be pure calculation logic) is a little odd; consider moving it to something like `src/copy/` later.
