insert into public.items (
  id, source, external_id, url, title, authors, abstract, published_at, signals
) values (
  '11111111-1111-4111-8111-111111111111',
  'arxiv',
  'fixture-001',
  'https://example.com/fixture-paper',
  'Deterministic Frontier Paper',
  array['Fixture Author'],
  'A deterministic local fixture for database and browser tests.',
  '2026-07-10T00:00:00.000Z',
  '{"category":"cs.AI","sourceWeight":1}'::jsonb
) on conflict (canonical_key) do update set
  title = excluded.title,
  abstract = excluded.abstract,
  signals = excluded.signals;

insert into public.summaries (
  id, item_id, one_liner, summary_md, impact_md, score, rank, model
) values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '确定性本地测试摘要',
  '这是用于验证迁移和页面渲染的固定内容。',
  '- 可验证空库重建\n- 可验证 Top5 关联',
  95,
  1,
  'fixture'
) on conflict (id) do update set
  one_liner = excluded.one_liner,
  summary_md = excluded.summary_md,
  impact_md = excluded.impact_md;

insert into public.digests (
  id, digest_date, top5_item_ids, rendered_md
) values (
  '33333333-3333-4333-8333-333333333333',
  '2026-07-10',
  array['11111111-1111-4111-8111-111111111111'::uuid],
  '# 前沿论文情报台 · 2026-07-10'
) on conflict (digest_date) do update set
  top5_item_ids = excluded.top5_item_ids,
  rendered_md = excluded.rendered_md;

insert into public.digest_items (
  digest_id, item_id, rank, score, one_liner, summary_md, impact_md, model
) values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  1, 95, '确定性本地测试摘要', '这是用于验证迁移和页面渲染的固定内容。',
  '- 可验证空库重建\n- 可验证 Top5 关联', 'fixture'
)
on conflict (digest_id, item_id) do update set
  rank = excluded.rank,
  score = excluded.score,
  one_liner = excluded.one_liner,
  summary_md = excluded.summary_md,
  impact_md = excluded.impact_md,
  model = excluded.model;

insert into public.feedback (
  id, item_id, digest_date, rating, note
) values (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  '2026-07-10',
  'up',
  '确定性测试反馈'
) on conflict (item_id) do update set
  digest_date = excluded.digest_date,
  rating = excluded.rating,
  note = excluded.note;

insert into public.annotations (id, item_id, type, anchor, color, body)
values (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'note',
  '{"x":0.25,"y":0.5}'::jsonb,
  '#e0c060',
  '确定性测试批注'
) on conflict (id) do update set body = excluded.body;

insert into public.chats (id, item_id, role, content)
values (
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  'user',
  '这篇论文的核心方法是什么？'
) on conflict (id) do update set content = excluded.content;
