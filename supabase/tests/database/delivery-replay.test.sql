begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

select has_column('public', 'delivery_outbox', 'requeue_count', 'manual replay count is audited');
select has_column('public', 'delivery_outbox', 'last_requeued_at', 'manual replay time is audited');
select has_function(
  'public', 'requeue_failed_deliveries', array['date', 'text[]', 'timestamp with time zone'],
  'failed delivery replay RPC exists'
);
select has_function(
  'public', 'claim_digest_delivery',
  array['date', 'uuid', 'timestamp with time zone', 'integer', 'integer'],
  'digest-scoped claim RPC exists'
);
select ok(
  not has_function_privilege('anon', 'public.requeue_failed_deliveries(date,text[],timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.requeue_failed_deliveries(date,text[],timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.requeue_failed_deliveries(date,text[],timestamptz)', 'EXECUTE'),
  'failed replay is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.claim_digest_delivery(date,uuid,timestamptz,integer,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_digest_delivery(date,uuid,timestamptz,integer,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_digest_delivery(date,uuid,timestamptz,integer,integer)', 'EXECUTE'),
  'digest-scoped claim is service-role only'
);

with rpc(signature) as (
  values
    ('public.requeue_failed_deliveries(date,text[],timestamptz)'::regprocedure),
    ('public.claim_digest_delivery(date,uuid,timestamptz,integer,integer)'::regprocedure)
)
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = rpc.signature)
    and (select pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid = rpc.signature) = 'postgres'
    and (select proconfig from pg_catalog.pg_proc where oid = rpc.signature) = array['search_path=""']::text[],
  format('%s is a hardened definer RPC', rpc.signature)
)
from rpc;

insert into public.items(id, source, external_id, title)
values ('d2000000-0000-4000-8000-000000000001', 'replay-test', 'replay-item', 'Replay item');
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values
  (
    'd2000000-0000-4000-8000-000000000002', '2099-07-01',
    array['d2000000-0000-4000-8000-000000000001'::uuid], '# replay'
  ),
  (
    'd2000000-0000-4000-8000-000000000003', '2099-07-02',
    array['d2000000-0000-4000-8000-000000000001'::uuid], '# other'
  );
insert into public.delivery_outbox(
  id, digest_date, channel, provider_id, idempotency_key, payload, status,
  attempts, last_error, delivered_at, next_attempt_at
) values
  (
    'd2000000-0000-4000-8000-000000000004', '2099-07-01', 'wechat', 'serverchan',
    'replay-test:failed', '{"title":"Replay","markdown":"# replay"}',
    'failed', 3, 'old provider error', null, '2099-07-01T00:00:00Z'
  ),
  (
    'd2000000-0000-4000-8000-000000000005', '2099-07-01', 'email', 'smtp',
    'replay-test:succeeded', '{"title":"Replay","markdown":"# replay"}',
    'succeeded', 1, null, '2099-07-01T00:01:00Z', '2099-07-01T00:00:00Z'
  ),
  (
    'd2000000-0000-4000-8000-000000000006', '2099-07-02', 'wechat', 'serverchan',
    'replay-test:other', '{"title":"Other","markdown":"# other"}',
    'pending', 0, null, null, '2099-07-01T00:00:00Z'
  );

set local role service_role;

select throws_ok(
  $$ select * from public.requeue_failed_deliveries(
       '2099-07-01', array['sms'], '2099-07-01T01:00:00Z'
     ) $$,
  '22023', 'invalid delivery replay',
  'unknown replay channels fail closed'
);
select results_eq(
  $$ select channel, delivery_status, attempts, requeue_count
     from public.requeue_failed_deliveries(
       '2099-07-01', array['wechat'], '2099-07-01T01:00:00Z'
     ) $$,
  $$ values ('wechat'::text, 'pending'::text, 3, 1) $$,
  'only the requested failed channel is requeued without resetting attempts'
);
set local role postgres;
select results_eq(
  $$ select last_error, lease_owner, lease_until, last_requeued_at
     from public.delivery_outbox where id = 'd2000000-0000-4000-8000-000000000004' $$,
  $$ values (null::text, null::uuid, null::timestamptz, '2099-07-01T01:00:00Z'::timestamptz) $$,
  'requeue clears terminal error and leases while recording its audit time'
);
select results_eq(
  $$ select status, requeue_count, delivered_at
     from public.delivery_outbox where id = 'd2000000-0000-4000-8000-000000000005' $$,
  $$ values ('succeeded'::text, 0, '2099-07-01T00:01:00Z'::timestamptz) $$,
  'successful delivery is never revived or rewritten'
);
set local role service_role;
select is(
  (select count(*) from public.requeue_failed_deliveries(
    '2099-07-01', array['wechat'], '2099-07-01T01:01:00Z'
  )),
  0::bigint,
  'requeue is idempotent once the row is pending'
);
select results_eq(
  $$ select digest_date, channel, attempts
     from public.claim_digest_delivery(
       '2099-07-01', 'd2000000-0000-4000-8000-000000000007',
       '2099-07-01T01:00:00Z', 300, 10
     ) $$,
  $$ values ('2099-07-01'::date, 'wechat'::text, 4) $$,
  'manual replay claims only the selected digest and increments attempts'
);
set local role postgres;
select results_eq(
  $$ select status, attempts from public.delivery_outbox
     where id = 'd2000000-0000-4000-8000-000000000006' $$,
  $$ values ('pending'::text, 0) $$,
  'an unrelated digest remains untouched'
);
set local role service_role;
select ok(
  not has_table_privilege('service_role', 'public.delivery_outbox', 'UPDATE'),
  'service role still cannot bypass replay RPC through direct updates'
);
select throws_ok(
  $$ select * from public.claim_digest_delivery(
       null, 'd2000000-0000-4000-8000-000000000007',
       '2099-07-01T01:00:00Z', 300, 10
     ) $$,
  '22023', 'invalid digest delivery claim',
  'invalid target identity fails closed'
);

select * from finish();
rollback;
