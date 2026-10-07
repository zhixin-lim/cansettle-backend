-- Run this in Supabase's SQL Editor on your EXISTING project (don't re-run
-- the whole schema.sql - this just updates the items table in place).
-- Safe to run even with existing rows: any item that already has an old
-- allocated_to list just starts fresh as unassigned afterwards (fine,
-- since nothing production-critical is in there yet).

alter table items add column unit_price_cents integer;
alter table items add column allocations jsonb not null default '[]';
alter table items drop column allocated_to;
