-- Run this in Supabase's SQL Editor on your EXISTING project.
-- Adds a discount to bills (a member discount, voucher or payment-app discount).

alter table bills add column discount_cents integer not null default 0;
