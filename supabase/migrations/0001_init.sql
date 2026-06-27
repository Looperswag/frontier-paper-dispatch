-- 前沿论文情报台 — 初始 schema。
-- 在 Supabase SQL Editor 里整段执行；本地 ingest 用 service_role key 写入。

create extension if not exists vector; -- Phase 5 跨库检索用

create table if not exists items (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  external_id  text not null,
  url          text not null default '',
  title        text not null,
  authors      text[] not null default '{}',
  abstract     text not null default '',
  content      text,
  published_at text not null default '',
  signals      jsonb not null default '{}',
  raw_json     jsonb,
  fetched_at   timestamptz not null default now(),
  unique (source, external_id)            -- 去重键，替代 seen.json
);
create index if not exists items_fetched_idx on items (fetched_at desc);

create table if not exists summaries (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references items(id) on delete cascade,
  one_liner  text not null default '',
  summary_md text not null default '',
  impact_md  text not null default '',
  score      int  not null default 0,
  rank       int  not null default 0,
  model      text not null default 'claude',
  created_at timestamptz not null default now()
);
create index if not exists summaries_item_idx on summaries (item_id);

create table if not exists digests (
  id            uuid primary key default gen_random_uuid(),
  digest_date   date not null unique,
  top5_item_ids uuid[] not null default '{}',
  rendered_md   text not null default '',
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- 批注（Phase 4）：anchor 存文本偏移或归一化几何坐标，type ∈ highlight|note|pen|box
create table if not exists annotations (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references items(id) on delete cascade,
  type       text not null,
  anchor     jsonb not null,
  color      text not null default '#e0c060',
  body       text,
  created_at timestamptz not null default now()
);
create index if not exists annotations_item_idx on annotations (item_id);

-- chatbot 二次问答（Phase 3）
create table if not exists chats (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references items(id) on delete cascade,
  role       text not null,            -- user | assistant
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists chats_item_idx on chats (item_id, created_at);

-- Phase 5：跨库检索向量
create table if not exists embeddings (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references items(id) on delete cascade,
  chunk     text not null,
  embedding vector(1024)
);
