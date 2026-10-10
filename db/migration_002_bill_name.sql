-- Run this in Supabase's SQL Editor on your EXISTING project.
-- Adds an optional name to bills (e.g. the shop name), so it no longer
-- has to live only on the host's phone.

alter table bills add column name text;
