begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(38);

select has_table('public', 'item_observations', 'canonical source observations exist');
select has_table('public', 'item_identity_aliases', 'legacy source identities have a canonical alias ledger');
select has_column('public', 'item_identity_aliases', 'item_id', 'source aliases retain their bound item');
select col_is_fk('public', 'item_identity_aliases', 'item_id', 'source alias item binding is referentially enforced');
select is(
  (select format_type(atttypid, atttypmod) from pg_catalog.pg_attribute where attrelid = 'public.items'::regclass and attname = 'canonical_key'),
  'text',
  'items persist a canonical work key'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.items'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (canonical_key)'
  ),
  'canonical work identity is unique'
);
select ok(
  not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.items'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (source, external_id)'
  ),
  'legacy source identity uniqueness cannot conflict with canonical upserts'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.item_observations'::regclass),
  'source observation history enables and forces RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = 'public.item_identity_aliases'::regclass),
  'identity alias ledger enables and forces RLS'
);
select ok(
  not has_table_privilege('service_role', 'public.item_observations', 'SELECT, INSERT, UPDATE, DELETE')
    and not has_table_privilege('service_role', 'public.item_identity_aliases', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role cannot rewrite identity audit ledgers directly'
);
select has_function(
  'public', 'canonical_item_key', array['text', 'text', 'text'],
  'database canonical identity implementation exists'
);
select has_function(
  'public', 'successful_delivery_canonical_keys', array['timestamp with time zone', 'timestamp with time zone'],
  'successful-delivery novelty lookup exists'
);
select ok(
  not has_function_privilege('anon', 'public.successful_delivery_canonical_keys(timestamptz,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.successful_delivery_canonical_keys(timestamptz,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.successful_delivery_canonical_keys(timestamptz,timestamptz)', 'EXECUTE'),
  'novelty lookup is service-role only'
);
select is(
  public.canonical_item_key('blog', 'https://example.com/posts/stable-guid', 'https://example.com/posts/stable-guid'),
  'blog:id:f94156d56b45303caa8cd9601658f6849287385920f84100fb23985067bd266f',
  'opaque source identity matches the TypeScript SHA-256 contract'
);
select isnt(
  public.canonical_item_key('github', 'Owner/Repo', 'https://github.com/Owner/Repo'),
  public.canonical_item_key('github', 'owner/repo', 'https://github.com/owner/repo'),
  'case-sensitive source identities remain distinct'
);
select is(
  public.canonical_item_key('blog', 'entry', 'https://openreview.net/forum?id=Ab%2FC'),
  'openreview:Ab%2FC',
  'OpenReview identity preserves encoded bytes'
);
select is(
  public.canonical_item_key('blog', 'entry', 'https://openreview.net:443/forum?id=AbC'),
  'openreview:AbC',
  'OpenReview identity accepts the normalized default HTTPS port'
);
select is(
  public.canonical_item_key('blog', 'entry', 'https://doi.org/10.1234/AB%2FC'),
  'doi:10.1234/ab%2fc',
  'DOI identity preserves encoded bytes'
);
select is(
  public.canonical_item_key('blog', 'entry', 'https://doi.org:443/10.1234/ABC'),
  'doi:10.1234/abc',
  'DOI identity accepts the normalized default HTTPS port'
);
select is(
  public.canonical_item_key('blog', '2607.12345v2', 'https://arxiv.org/abs/2607.12345v2'),
  'blog:2607.12345v2',
  'an arXiv-looking blog URL cannot change an untrusted source identity'
);

insert into public.items(
  id, canonical_key, source, external_id, url, title, authors, abstract, published_at, signals, provenance
) values (
  'abababab-abab-4bab-8bab-ababababab01', 'doi:10.1000/identity', 'openalex',
  'https://doi.org/10.1000/identity', 'https://doi.org/10.1000/identity', 'Identity paper',
  array['Alice'], 'abstract', '2026-07-15T00:00:00.000Z', '{"citations":2}'::jsonb,
  '[{"source":"openalex","externalId":"https://doi.org/10.1000/identity","url":"https://doi.org/10.1000/identity","signals":{"citations":2}}]'::jsonb
);
insert into public.items(
  canonical_key, source, external_id, url, title, authors, abstract, published_at, signals, provenance
) values (
  'doi:10.1000/identity', 'arxiv', '2607.00001', 'https://arxiv.org/abs/2607.00001',
  'Identity paper revised', array['Alice'], 'longer abstract', '2026-07-15T01:00:00.000Z', '{"citations":3}'::jsonb,
  '[{"source":"arxiv","externalId":"2607.00001","url":"https://arxiv.org/abs/2607.00001","signals":{"citations":3}}]'::jsonb
)
on conflict (canonical_key) do update set
  source = excluded.source,
  external_id = excluded.external_id,
  url = excluded.url,
  title = excluded.title,
  abstract = excluded.abstract,
  signals = excluded.signals,
  provenance = excluded.provenance;

select is((select count(*) from public.items where canonical_key = 'doi:10.1000/identity'), 1::bigint, 'cross-source upsert keeps one item');
select is((select jsonb_array_length(provenance) from public.items where canonical_key = 'doi:10.1000/identity'), 2, 'upsert unions source provenance');
select is((select count(*) from public.item_observations where item_id = 'abababab-abab-4bab-8bab-ababababab01'), 2::bigint, 'source observations are retained independently');
select results_eq(
  $$ select source, (signals ->> 'citations')::integer
     from public.item_observations
     where item_id = 'abababab-abab-4bab-8bab-ababababab01'
     order by source $$,
  $$ values ('arxiv'::text, 3), ('openalex'::text, 2) $$,
  'each source retains its own metrics'
);

update public.items
set provenance = '[{"source":"openalex","externalId":"https://doi.org/10.1000/identity","url":"https://doi.org/10.1000/identity-new","signals":{"citations":5}}]'::jsonb
where id = 'abababab-abab-4bab-8bab-ababababab01';
select results_eq(
  $$ select url, (signals ->> 'citations')::integer
     from public.item_observations
     where item_id = 'abababab-abab-4bab-8bab-ababababab01' and source = 'openalex' $$,
  $$ values ('https://doi.org/10.1000/identity-new'::text, 5) $$,
  'a newer observation replaces the old URL and metrics for that source only'
);

update public.items
set abstract = repeat('rich abstract ', 20), content = 'full retained content'
where id = 'abababab-abab-4bab-8bab-ababababab01';
insert into public.items(
  canonical_key, source, external_id, url, title, abstract, content, provenance
) values (
  'doi:10.1000/identity', 'blog', 'identity-post', 'https://doi.org/10.1000/identity',
  'Identity paper short feed', 'short', null,
  '[{"source":"blog","externalId":"identity-post","url":"https://doi.org/10.1000/identity","signals":{"social":9}}]'::jsonb
)
on conflict (canonical_key) do update set
  source = excluded.source,
  external_id = excluded.external_id,
  url = excluded.url,
  title = excluded.title,
  abstract = excluded.abstract,
  content = excluded.content,
  provenance = excluded.provenance;
select ok(
  (select pg_catalog.octet_length(abstract) > pg_catalog.octet_length('short')
          and content = 'full retained content'
   from public.items where canonical_key = 'doi:10.1000/identity'),
  'a short feed update cannot erase richer persisted content'
);

insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values (
  'abababab-abab-4bab-8bab-ababababab02', '2098-06-17',
  array['abababab-abab-4bab-8bab-ababababab01'::uuid], '# identity'
);
insert into public.digest_items(digest_id, item_id, rank, score, one_liner, summary_md, impact_md, model)
values (
  'abababab-abab-4bab-8bab-ababababab02', 'abababab-abab-4bab-8bab-ababababab01',
  1, 90, 'one', 'summary', 'impact', 'test'
);

select is(
  (select count(*) from public.successful_delivery_canonical_keys('2098-06-01T00:00:00Z', '2098-07-01T00:00:00Z')),
  0::bigint,
  'saved but undelivered digests do not suppress candidates'
);
insert into public.delivery_outbox(
  digest_date, channel, provider_id, idempotency_key, payload, status, attempts, delivered_at
) values (
  '2098-06-17', 'email', 'smtp', 'identity-test:email',
  '{"title":"Digest","markdown":"# digest"}'::jsonb, 'succeeded', 1, '2098-06-20T00:00:00Z'
);
select is(
  (select count(*) from public.successful_delivery_canonical_keys('2098-06-21T00:00:00Z', '2098-07-01T00:00:00Z')),
  0::bigint,
  'deliveries outside the actual delivery window do not suppress candidates'
);
select results_eq(
  $$ select distinct canonical_key from public.successful_delivery_canonical_keys('2098-06-01T00:00:00Z', '2098-07-01T00:00:00Z') $$,
  $$ values ('doi:10.1000/identity'::text) $$,
  'a successful channel exposes the canonical novelty key'
);

insert into public.items(
  id, canonical_key, source, external_id, url, title, provenance
) values (
  'abababab-abab-4bab-8bab-ababababab05',
  'legacy:abababab-abab-4bab-8bab-ababababab05',
  'huggingface', '2607.00009', 'https://huggingface.co/papers/2607.00009', 'Legacy duplicate',
  '[{"source":"huggingface","externalId":"2607.00009","url":"https://huggingface.co/papers/2607.00009","signals":{}}]'::jsonb
);
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values (
  'abababab-abab-4bab-8bab-ababababab06', '2098-06-18',
  array['abababab-abab-4bab-8bab-ababababab05'::uuid], '# legacy'
);
insert into public.delivery_outbox(
  digest_date, channel, provider_id, idempotency_key, payload, status, attempts, delivered_at
) values (
  '2098-06-18', 'email', 'smtp', 'legacy-identity-test:email',
  '{"title":"Legacy","markdown":"# legacy"}'::jsonb, 'succeeded', 1, '2098-06-22T00:00:00Z'
);
select ok(
  exists (
    select 1
    from public.successful_delivery_canonical_keys('2098-06-21T00:00:00Z', '2098-07-01T00:00:00Z')
    where canonical_key = 'arxiv:2607.00009'
  ),
  'successful legacy rows resolve through their canonical source alias'
);

insert into public.items(
  id, canonical_key, source, external_id, url, title, provenance
) values (
  'abababab-abab-4bab-8bab-ababababab07', 'blog:stable-source',
  'blog', 'stable-source', 'https://example.com/stable-source', 'Stable source',
  '[{"source":"blog","externalId":"stable-source","url":"https://example.com/stable-source","signals":{"views":1}}]'::jsonb
);
update public.item_observations
set observed_at = '2001-01-01T00:00:00Z'
where item_id = 'abababab-abab-4bab-8bab-ababababab07' and source = 'blog';
update public.item_identity_aliases
set last_seen_at = '2001-01-01T00:00:00Z'
where item_id = 'abababab-abab-4bab-8bab-ababababab07' and canonical_key = 'blog:stable-source';
update public.items
set provenance = '[{"source":"github","externalId":"Owner/Repo","url":"https://github.com/Owner/Repo","signals":{"stars":9}}]'::jsonb
where id = 'abababab-abab-4bab-8bab-ababababab07';
select is(
  (select observed_at from public.item_observations
   where item_id = 'abababab-abab-4bab-8bab-ababababab07' and source = 'blog'),
  '2001-01-01T00:00:00Z'::timestamptz,
  'merged historical provenance is not replayed as a current observation'
);
select is(
  (select last_seen_at from public.item_identity_aliases
   where item_id = 'abababab-abab-4bab-8bab-ababababab07'
     and identity_hash = public.source_identity_hash('blog', 'stable-source')),
  '2001-01-01T00:00:00Z'::timestamptz,
  'merged historical provenance does not refresh an alias last-seen time'
);
select is(
  (select count(*) from public.item_observations
   where item_id = 'abababab-abab-4bab-8bab-ababababab07' and source = 'github'),
  1::bigint,
  'the source actually supplied by an update receives one observation'
);

insert into public.items(
  id, canonical_key, source, external_id, url, title, provenance
) values (
  'abababab-abab-4bab-8bab-ababababab08', 'blog:drift-entry',
  'blog', 'drift-entry', 'https://example.com/drift-entry', 'Drift entry',
  '[{"source":"blog","externalId":"drift-entry","url":"https://example.com/drift-entry","signals":{}}]'::jsonb
);
insert into public.items(
  canonical_key, source, external_id, url, title, provenance
) values (
  'doi:10.1234/drift', 'blog', 'drift-entry', 'https://doi.org/10.1234/drift', 'Drift entry DOI',
  '[{"source":"blog","externalId":"drift-entry","url":"https://doi.org/10.1234/drift","signals":{"citations":3}}]'::jsonb
)
on conflict (canonical_key) do update set
  source = excluded.source,
  external_id = excluded.external_id,
  url = excluded.url,
  title = excluded.title,
  provenance = excluded.provenance;
select is(
  (select count(*) from public.items where id = 'abababab-abab-4bab-8bab-ababababab08'),
  1::bigint,
  'a source identity cannot create a second row when its URL gains a DOI'
);
select is(
  (select canonical_key from public.items where id = 'abababab-abab-4bab-8bab-ababababab08'),
  'blog:drift-entry',
  'source identity drift retains its original canonical row'
);
select results_eq(
  $$ select item_id, canonical_key
     from public.item_identity_aliases
     where identity_hash = public.source_identity_hash('blog', 'drift-entry') $$,
  $$ values (
       'abababab-abab-4bab-8bab-ababababab08'::uuid,
       'blog:drift-entry'::text
     ) $$,
  'a source alias remains immutably bound to its original item and canonical key'
);

select throws_ok(
  $$ insert into public.items(id, source, external_id, title, provenance)
     values (
       'abababab-abab-4bab-8bab-ababababab03', 'blog', 'bad-provenance', 'bad',
       '[{"source":1,"externalId":"x","url":"https://example.com"}]'::jsonb
     ) $$,
  '23514',
  null,
  'malformed provenance is rejected'
);
select throws_ok(
  $$ insert into public.items(id, canonical_key, source, external_id, title)
     values ('abababab-abab-4bab-8bab-ababababab04', 'doi:10.1000/identity', 'blog', 'duplicate', 'duplicate') $$,
  '23505',
  null,
  'a canonical identity cannot create a second row'
);

select * from finish();
rollback;
