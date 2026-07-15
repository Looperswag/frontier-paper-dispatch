begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

select has_table(
  'public',
  'feedback_token_redemptions',
  'one-time feedback redemption ledger exists'
);
select col_is_pk(
  'public',
  'feedback_token_redemptions',
  'nonce_hash',
  'nonce hash is the primary replay key'
);
select fk_ok(
  'public', 'feedback_token_redemptions', 'item_id',
  'public', 'items', 'id',
  'redemption item references items'
);
select fk_ok(
  'public', 'feedback_token_redemptions', 'digest_date',
  'public', 'digests', 'digest_date',
  'redemption digest date references digests'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.feedback_token_redemptions'::regclass
      and conname = 'feedback_token_redemptions_digest_item_key'
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (digest_date, item_id)'
  ),
  'one action is allowed per digest item even if a nonce changes'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'feedback_token_redemptions'
      and indexname = 'feedback_token_redemptions_expires_idx'
      and indexdef like '%(expires_at)%'
  ),
  'expired ledger rows are indexable for retention cleanup'
);
select ok(
  (select attnotnull from pg_catalog.pg_attribute
   where attrelid = 'public.feedback_token_redemptions'::regclass
     and attname = 'token_version' and not attisdropped),
  'token version is required'
);
select ok(
  (select attnotnull from pg_catalog.pg_attribute
   where attrelid = 'public.feedback_token_redemptions'::regclass
     and attname = 'rating' and not attisdropped),
  'rating is required'
);
select ok(
  (select attnotnull from pg_catalog.pg_attribute
   where attrelid = 'public.feedback_token_redemptions'::regclass
     and attname = 'expires_at' and not attisdropped),
  'expiry is required'
);
select ok(
  (select attnotnull from pg_catalog.pg_attribute
   where attrelid = 'public.feedback_token_redemptions'::regclass
     and attname = 'redeemed_at' and not attisdropped),
  'redemption time is required'
);

insert into public.items(id, source, external_id, title)
values
  ('77777777-7777-4777-8777-777777777771', 'feedback-test', 'one', 'Feedback One'),
  ('77777777-7777-4777-8777-777777777772', 'feedback-test', 'two', 'Feedback Two'),
  ('77777777-7777-4777-8777-777777777773', 'feedback-test', 'three', 'Feedback Three');
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values (
  '88888888-8888-4888-8888-888888888888',
  '2099-01-01',
  array[
    '77777777-7777-4777-8777-777777777771'::uuid,
    '77777777-7777-4777-8777-777777777772'::uuid,
    '77777777-7777-4777-8777-777777777773'::uuid
  ],
  'feedback redemption test'
);
insert into public.feedback(item_id, digest_date, rating, note)
values (
  '77777777-7777-4777-8777-777777777771',
  '2099-01-01',
  'down',
  'preserve this owner note'
);

create temporary table first_redemption as
select * from public.redeem_feedback_token(
  1::smallint,
  repeat('a', 64),
  '2099-01-01',
  '77777777-7777-4777-8777-777777777771',
  'up',
  clock_timestamp() + interval '1 day'
);

select is((select count(*) from first_redemption), 1::bigint, 'RPC returns exactly one row');
select is((select outcome from first_redemption), 'recorded', 'first redemption records');
select is(
  (select persisted_item_id from first_redemption),
  '77777777-7777-4777-8777-777777777771'::uuid,
  'RPC echoes the persisted item'
);
select is((select persisted_digest_date from first_redemption), '2099-01-01'::date, 'RPC echoes digest');
select is((select persisted_rating from first_redemption), 'up', 'RPC echoes rating');
select ok((select feedback_id is not null and redeemed_at is not null from first_redemption), 'RPC acknowledges IDs and time');
select is(
  (select count(*) from public.feedback_token_redemptions where nonce_hash = repeat('a', 64)),
  1::bigint,
  'ledger stores one hashed redemption'
);
select results_eq(
  $$ select digest_date, item_id, rating, note from public.feedback
     where item_id = '77777777-7777-4777-8777-777777777771'::uuid $$,
  $$ values ('2099-01-01'::date,
     '77777777-7777-4777-8777-777777777771'::uuid,
     'up'::text,
     'preserve this owner note'::text) $$,
  'atomic redemption changes rating without erasing an owner note'
);

create temporary table replay_result as
select * from public.redeem_feedback_token(
  1::smallint, repeat('a', 64), '2099-01-01',
  '77777777-7777-4777-8777-777777777771', 'down',
  clock_timestamp() + interval '1 day'
);
select is((select outcome from replay_result), 'already_redeemed', 'same nonce opposite rating is blocked');
select ok(
  (select feedback_id is null and persisted_item_id is null and redeemed_at is null from replay_result),
  'replay response returns no persisted record details'
);

create temporary table resigned_result as
select * from public.redeem_feedback_token(
  1::smallint, repeat('b', 64), '2099-01-01',
  '77777777-7777-4777-8777-777777777771', 'down',
  clock_timestamp() + interval '1 day'
);
select is((select outcome from resigned_result), 'already_redeemed', 'different nonce for same digest item is blocked');
select is(
  (select rating from public.feedback where item_id = '77777777-7777-4777-8777-777777777771'),
  'up',
  'replays cannot overwrite the first rating'
);

create temporary table expired_result as
select * from public.redeem_feedback_token(
  1::smallint, repeat('c', 64), '2099-01-01',
  '77777777-7777-4777-8777-777777777772', 'up',
  clock_timestamp() - interval '1 second'
);
select is((select outcome from expired_result), 'expired', 'database clock rejects expired token');
select is(
  (select count(*) from public.feedback_token_redemptions where nonce_hash = repeat('c', 64)),
  0::bigint,
  'expired token consumes no nonce'
);

create temporary table context_result as
select * from public.redeem_feedback_token(
  1::smallint, repeat('d', 64), '2026-07-10',
  '77777777-7777-4777-8777-777777777772', 'up',
  clock_timestamp() + interval '1 day'
);
select is((select outcome from context_result), 'invalid_context', 'non-member digest item is rejected');
select is(
  (select count(*) from public.feedback_token_redemptions where nonce_hash = repeat('d', 64)),
  0::bigint,
  'invalid context consumes no nonce'
);

create temporary table invalid_result as
select * from public.redeem_feedback_token(
  2::smallint, 'raw-nonce', '2099-01-01',
  '77777777-7777-4777-8777-777777777772', 'maybe',
  clock_timestamp() + interval '1 day'
);
select is((select outcome from invalid_result), 'invalid_request', 'malformed RPC input fails closed');

create function pg_temp.block_feedback_write()
returns trigger language plpgsql as $$
begin
  if new.item_id = '77777777-7777-4777-8777-777777777773'::uuid then
    raise exception 'feedback write blocked';
  end if;
  return new;
end;
$$;
create trigger block_feedback_write
before insert or update on public.feedback
for each row execute function pg_temp.block_feedback_write();

select throws_ok(
  $$ select * from public.redeem_feedback_token(
    1::smallint, repeat('e', 64), '2099-01-01',
    '77777777-7777-4777-8777-777777777773', 'up',
    clock_timestamp() + interval '1 day'
  ) $$,
  'P0001',
  'feedback write blocked',
  'feedback failure escapes and rolls back the ledger insert'
);
select is(
  (select count(*) from public.feedback_token_redemptions where nonce_hash = repeat('e', 64)),
  0::bigint,
  'failed feedback write rolls back nonce consumption'
);
select is(
  (select count(*) from public.feedback where item_id = '77777777-7777-4777-8777-777777777773'),
  0::bigint,
  'failed feedback write leaves no feedback row'
);

select * from finish();
rollback;
