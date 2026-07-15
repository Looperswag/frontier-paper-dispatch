-- Assertions for a database populated before canonical identity existed.
do $$
declare
  v_blog_key text;
  v_novelty text;
begin
  v_blog_key := public.canonical_item_key(
    'blog',
    'https://example.com/posts/stable-guid',
    'https://example.com/posts/stable-guid'
  );
  if v_blog_key <> 'blog:id:f94156d56b45303caa8cd9601658f6849287385920f84100fb23985067bd266f' then
    raise exception 'populated upgrade canonical parity failed: %', v_blog_key;
  end if;

  if (select count(*) from public.item_observations
      where item_id in (
        'c1000000-0000-4000-8000-000000000001',
        'c1000000-0000-4000-8000-000000000002',
        'c1000000-0000-4000-8000-000000000003'
      )) <> 3 then
    raise exception 'populated upgrade did not backfill legacy observations';
  end if;

  if not exists (
    select 1 from public.item_identity_aliases
    where identity_hash = public.source_identity_hash('huggingface', '2607.00001')
      and canonical_key = 'arxiv:2607.00001'
  ) then
    raise exception 'populated upgrade did not map a legacy duplicate alias';
  end if;

  if not exists (
    select 1 from public.items
    where id = 'c1000000-0000-4000-8000-000000000006'
      and pg_catalog.octet_length(canonical_key) < 512
      and canonical_key like 'blog:id:%'
  ) then
    raise exception 'oversized legacy identity was not bounded safely';
  end if;

  insert into public.items(
    canonical_key, source, external_id, url, title, authors, abstract,
    published_at, signals, provenance
  ) values (
    v_blog_key, 'blog', 'https://example.com/posts/stable-guid',
    'https://example.com/posts/stable-guid', 'Publisher revised title', '{}', '', '', '{}',
    '[{"source":"blog","externalId":"https://example.com/posts/stable-guid","url":"https://example.com/posts/stable-guid","signals":{}}]'::jsonb
  )
  on conflict (canonical_key) do update set
    title = excluded.title,
    provenance = excluded.provenance;

  if (select count(*) from public.items
      where source = 'blog'
        and external_id = 'https://example.com/posts/stable-guid') <> 1 then
    raise exception 'populated blog upsert created a duplicate';
  end if;

  insert into public.delivery_outbox(
    digest_date, channel, provider_id, idempotency_key, payload,
    status, attempts, delivered_at
  ) values (
    '2001-01-01', 'email', 'smtp', 'populated-upgrade:email',
    '{"title":"Legacy","markdown":"legacy"}'::jsonb,
    'succeeded', 1, clock_timestamp()
  );

  select canonical_key into v_novelty
  from public.successful_delivery_canonical_keys(
    clock_timestamp() - interval '1 hour',
    clock_timestamp() + interval '1 hour'
  )
  where canonical_key = 'arxiv:2607.00001';
  if v_novelty is distinct from 'arxiv:2607.00001' then
    raise exception 'legacy successful delivery did not resolve canonical novelty';
  end if;
end;
$$;
