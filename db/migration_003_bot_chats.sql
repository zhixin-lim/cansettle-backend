-- Run this in Supabase's SQL Editor on your EXISTING project.
-- Adds the table the Telegram bot uses to remember each chat.

create table bot_chats (
  chat_id     bigint primary key,                 -- the Telegram chat
  state       jsonb not null,                     -- which settlement it is on + the receipt awaiting confirmation
  updated_at  timestamptz not null default now()  -- rows older than 24h are swept away
);
