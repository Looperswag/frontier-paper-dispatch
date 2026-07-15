begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

select has_table('public', 'delivery_alerts', 'delivery alert dedupe ledger exists');
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class where oid = 'public.delivery_alerts'::regclass),
  'delivery alert ledger enables and forces RLS'
);
select ok(
  not has_table_privilege('service_role', 'public.delivery_alerts', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role cannot rewrite delivery alert dedupe directly'
);
select has_function(
  'public', 'get_delivery_health', array['date'],
  'delivery health query exists'
);
select has_function(
  'public', 'claim_delivery_alert',
  array['date', 'text', 'uuid', 'timestamp with time zone', 'integer'],
  'atomic delivery alert claim exists'
);
select has_function(
  'public', 'finish_delivery_alert', array['date', 'text', 'uuid', 'text', 'text'],
  'delivery alert completion exists'
);
select ok(
  not has_function_privilege('anon', 'public.get_delivery_health(date)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_delivery_health(date)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_delivery_health(date)', 'EXECUTE'),
  'delivery health query is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.claim_delivery_alert(date,text,uuid,timestamptz,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_delivery_alert(date,text,uuid,timestamptz,integer)', 'EXECUTE'),
  'delivery alert claim is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.finish_delivery_alert(date,text,uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.finish_delivery_alert(date,text,uuid,text,text)', 'EXECUTE'),
  'delivery alert completion is service-role only'
);

insert into public.delivery_outbox(
  digest_date, channel, provider_id, idempotency_key, payload, status, attempts, delivered_at
) values
  (
    '2026-07-10', 'email', 'smtp', 'health-test:email',
    '{"title":"health","markdown":"health"}'::jsonb, 'succeeded', 1, '2026-07-10T15:00:00Z'
  ),
  (
    '2026-07-10', 'wechat', 'serverchan', 'health-test:wechat',
    '{"title":"health","markdown":"health"}'::jsonb, 'pending', 2, null
  );

select results_eq(
  $$ select channel, status, attempts from public.get_delivery_health('2026-07-10') order by channel $$,
  $$ values ('email'::text, 'succeeded'::text, 1), ('wechat'::text, 'pending'::text, 2) $$,
  'health query returns exact per-channel terminal and pending state'
);
select is(
  (select count(*) from public.get_delivery_health('2099-12-31')),
  0::bigint,
  'a date with no delivery has no false success'
);

set local role service_role;
select results_eq(
  $$ select claimed, alert_status, attempts
     from public.claim_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000001', '2026-07-10T15:30:00Z', 300
     ) $$,
  $$ values (true, 'in_flight'::text, 1) $$,
  'first deadline alert worker obtains a lease'
);
select results_eq(
  $$ select claimed, alert_status, attempts
     from public.claim_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000002', '2026-07-10T15:31:00Z', 300
     ) $$,
  $$ values (false, 'in_flight'::text, 1) $$,
  'a live alert lease prevents duplicate notification'
);
select throws_ok(
  $$ select * from public.finish_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000002', 'success', null
     ) $$,
  'P0001', null,
  'another worker cannot finish the alert lease'
);
select results_eq(
  $$ select alert_status from public.finish_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000001', 'retry', 'webhook unavailable'
     ) $$,
  $$ values ('pending'::text) $$,
  'a failed independent webhook releases the alert for retry'
);
select results_eq(
  $$ select claimed, alert_status, attempts
     from public.claim_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000002', '2026-07-10T15:32:00Z', 300
     ) $$,
  $$ values (true, 'in_flight'::text, 2) $$,
  'a released alert can be reclaimed'
);
select results_eq(
  $$ select alert_status from public.finish_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000002', 'success', null
     ) $$,
  $$ values ('succeeded'::text) $$,
  'successful alert completion is durable'
);
select results_eq(
  $$ select claimed, alert_status, attempts
     from public.claim_delivery_alert(
       '2026-07-10', 'deadline:email,wechat',
       'd1000000-0000-4000-8000-000000000001', '2026-07-10T16:00:00Z', 300
     ) $$,
  $$ values (false, 'succeeded'::text, 2) $$,
  'a successful deadline alert is never sent twice'
);
reset role;

select is(
  (select count(*) from public.delivery_alerts where status = 'succeeded'),
  1::bigint,
  'exactly one successful dedupe row remains'
);
select throws_ok(
  $$ select * from public.claim_delivery_alert(
       '2026-07-10', repeat('x', 129),
       'd1000000-0000-4000-8000-000000000001', '2026-07-10T16:00:00Z', 300
     ) $$,
  '22023', null,
  'oversized alert keys fail closed'
);

select * from finish();
rollback;
