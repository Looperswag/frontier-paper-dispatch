-- 每日 Top5 反馈表。在 Supabase SQL Editor 执行。
create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade,
  digest_date date,
  rating      text not null check (rating in ('up','down')),
  note        text,
  created_at  timestamptz not null default now(),
  unique (item_id)          -- 一篇一条，改主意就 upsert
);
create index if not exists feedback_created_idx on feedback (created_at desc);
