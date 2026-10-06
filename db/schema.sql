-- CanSettle schema
-- Paste this whole file into Supabase's SQL Editor and click Run.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  label       text,                                   -- e.g. "Dinner + Dessert"
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '24 hours')
);

create table participants (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references sessions(id) on delete cascade,
  name              text not null,
  telegram_user_id  text,                              -- null until Telegram identity is wired in
  created_at        timestamptz not null default now() -- creation order = tie-break rule for the engine
);
create index idx_participants_session on participants(session_id);

create table bills (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references sessions(id) on delete cascade,
  source                 text not null check (source in ('receipt', 'manual')),
  payer_id               uuid not null references participants(id),
  service_charge_cents   integer not null default 0,
  gst_cents              integer not null default 0,
  total_cents            integer not null,
  created_at             timestamptz not null default now()
);
create index idx_bills_session on bills(session_id);

create table items (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills(id) on delete cascade,
  name          text not null,
  quantity      integer not null default 1,
  total_cents   integer not null,
  -- resolved allocation - this is what feeds directly into the calculation
  -- engine's `allocatedTo`. Empty array = still unassigned.
  allocated_to  uuid[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index idx_items_bill on items(bill_id);

-- Raw claims from Mode B, kept separate from the resolved `allocated_to`
-- above so a genuine shared item and a real conflict can be told apart:
-- claim_type = 'solo'   -> this person says the item was theirs alone
-- claim_type = 'shared' -> this person says it was shared; shared_with
--                          names who else had it
-- Two 'solo' claims on the same item = the real collision case.
create table item_claims (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items(id) on delete cascade,
  participant_id  uuid not null references participants(id),
  claim_type      text not null check (claim_type in ('solo', 'shared')),
  shared_with     uuid[] not null default '{}',
  created_at      timestamptz not null default now()
);
create index idx_item_claims_item on item_claims(item_id);

-- Prototype note: RLS is left OFF for now since there's no real user
-- accounts, only session-scoped access via an unguessable session id in
-- the URL. Before this goes anywhere near production, tighten access so a
-- session id alone can't be used to read/write every table (e.g. enable
-- RLS with a policy keyed off the session id, or move writes behind the
-- backend entirely and only expose the backend's own API).
