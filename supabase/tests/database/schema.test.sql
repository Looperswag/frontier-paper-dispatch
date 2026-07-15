begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(45);

select has_extension('vector', 'vector extension is installed');

select has_table('public', 'annotations', 'public.annotations exists');
select has_table('public', 'chats', 'public.chats exists');
select has_table('public', 'digests', 'public.digests exists');
select has_table('public', 'embeddings', 'public.embeddings exists');
select has_table('public', 'feedback', 'public.feedback exists');
select has_table('public', 'items', 'public.items exists');
select has_table('public', 'summaries', 'public.summaries exists');
select has_table('public', 'delivery_outbox', 'public.delivery_outbox exists');
select has_table('public', 'summary_versions', 'public.summary_versions exists');
select has_table('public', 'pipeline_runs', 'public.pipeline_runs exists');
select has_table('public', 'source_runs', 'public.source_runs exists');
select has_table('public', 'digest_items', 'public.digest_items exists');
select has_table('public', 'item_observations', 'public.item_observations exists');
select has_table('public', 'delivery_alerts', 'public.delivery_alerts exists');

with child_tables(name) as (
  values ('annotations'), ('chats'), ('embeddings'), ('feedback'), ('summaries')
)
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = format('public.%I', child_tables.name)::regclass
      and c.confrelid = 'public.items'::regclass
      and c.contype = 'f'
  ),
  format('public.%I has an item foreign key', child_tables.name)
)
from child_tables;

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_outbox'::regclass
      and confrelid = 'public.digests'::regclass
      and contype = 'f'
  ),
  'public.delivery_outbox has a digest foreign key'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.summary_versions'::regclass
      and confrelid = 'public.items'::regclass
      and contype = 'f'
  ),
  'public.summary_versions has an item foreign key'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.source_runs'::regclass
      and confrelid = 'public.pipeline_runs'::regclass
      and contype = 'f'
  ),
  'public.source_runs has a pipeline run foreign key'
);

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.pipeline_runs'::regclass)
    and (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.source_runs'::regclass),
  'pipeline run tables enable and force RLS'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.digest_items'::regclass
      and confrelid = 'public.digests'::regclass
      and contype = 'f'
  ) and exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.digest_items'::regclass
      and confrelid = 'public.items'::regclass
      and contype = 'f'
  ),
  'public.digest_items has digest and item foreign keys'
);

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.digest_items'::regclass),
  'digest item history forces RLS'
);

select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.items'::regclass and attname = 'provenance'),
  'jsonb',
  'items retain source provenance observations'
);
select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.items'::regclass and attname = 'canonical_key'),
  'text',
  'items persist canonical work identity'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.items'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (canonical_key)'
  ),
  'items canonical identity is unique'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.item_observations'::regclass),
  'item observations force RLS'
);
select has_function(
  'public', 'successful_delivery_canonical_keys', array['timestamp with time zone', 'timestamp with time zone'],
  'successful-delivery canonical novelty lookup exists'
);

select ok(
  not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.items'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (source, external_id)'
  ),
  'legacy source/external_id uniqueness cannot conflict with canonical identity'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.digests'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (digest_date)'
  ),
  'digests has one row per date'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.feedback'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (item_id)'
  ),
  'feedback currently has one mutable row per item'
);

select is((select count(*) from public.items where id = '11111111-1111-4111-8111-111111111111'), 1::bigint, 'item seed exists once');
select is((select count(*) from public.summaries where id = '22222222-2222-4222-8222-222222222222'), 1::bigint, 'summary seed exists once');
select is((select count(*) from public.digests where id = '33333333-3333-4333-8333-333333333333'), 1::bigint, 'digest seed exists once');
select is((select count(*) from public.feedback where id = '44444444-4444-4444-8444-444444444444'), 1::bigint, 'feedback seed exists once');
select is((select count(*) from public.annotations where id = '55555555-5555-4555-8555-555555555555'), 1::bigint, 'annotation seed exists once');
select is((select count(*) from public.chats where id = '66666666-6666-4666-8666-666666666666'), 1::bigint, 'chat seed exists once');

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.feedback'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%rating%up%down%'
  ),
  'feedback rating is constrained to up/down'
);

select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.embeddings'::regclass and attname = 'embedding'),
  'vector(1024)',
  'embedding dimension is fixed at 1024'
);
select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.digests'::regclass and attname = 'top5_item_ids'),
  'uuid[]',
  'digest item ids use uuid[]'
);
select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.items'::regclass and attname = 'authors'),
  'text[]',
  'authors use text[]'
);
select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.items'::regclass and attname = 'signals'),
  'jsonb',
  'signals use jsonb'
);

select * from finish();
rollback;
