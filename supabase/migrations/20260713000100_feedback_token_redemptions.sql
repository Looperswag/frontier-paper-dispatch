-- One-time signed feedback redemption. The Web server verifies HMAC claims;
-- this sealed ledger and RPC enforce replay, digest membership, DB-clock expiry,
-- and feedback persistence in one transaction.

create table public.feedback_token_redemptions (
  nonce_hash text primary key,
  token_version smallint not null,
  digest_date date not null,
  item_id uuid not null,
  rating text not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz not null,
  constraint feedback_token_redemptions_nonce_hash_check
    check (nonce_hash ~ '^[0-9a-f]{64}$'),
  constraint feedback_token_redemptions_version_check
    check (token_version = 1),
  constraint feedback_token_redemptions_rating_check
    check (rating in ('up', 'down')),
  constraint feedback_token_redemptions_time_check
    check (isfinite(expires_at) and isfinite(redeemed_at) and redeemed_at < expires_at),
  constraint feedback_token_redemptions_digest_fk
    foreign key (digest_date) references public.digests(digest_date)
    on update restrict on delete restrict,
  constraint feedback_token_redemptions_item_fk
    foreign key (item_id) references public.items(id)
    on update restrict on delete restrict,
  constraint feedback_token_redemptions_digest_item_key
    unique (digest_date, item_id)
);

create index feedback_token_redemptions_expires_idx
  on public.feedback_token_redemptions (expires_at);

alter table public.feedback_token_redemptions enable row level security;
alter table public.feedback_token_redemptions force row level security;

-- The ledger is deliberately inaccessible even to service_role. All writes go
-- through the narrowly scoped SECURITY DEFINER function below.
revoke all privileges on table public.feedback_token_redemptions
  from public, anon, authenticated, service_role;

create or replace function public.redeem_feedback_token(
  p_token_version smallint,
  p_nonce_hash text,
  p_digest_date date,
  p_item_id uuid,
  p_rating text,
  p_expires_at timestamptz
)
returns table (
  outcome text,
  feedback_id uuid,
  persisted_item_id uuid,
  persisted_digest_date date,
  persisted_rating text,
  redeemed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_redeemed_at timestamptz;
  v_feedback_id uuid;
begin
  if p_token_version is distinct from 1
     or p_nonce_hash is null
     or p_nonce_hash !~ '^[0-9a-f]{64}$'
     or p_digest_date is null
     or p_item_id is null
     or p_rating is null
     or p_rating not in ('up', 'down')
     or p_expires_at is null
     or not isfinite(p_expires_at) then
    return query select
      'invalid_request'::text,
      null::uuid,
      null::uuid,
      null::date,
      null::text,
      null::timestamptz;
    return;
  end if;

  if p_expires_at <= v_now then
    return query select
      'expired'::text,
      null::uuid,
      null::uuid,
      null::date,
      null::text,
      null::timestamptz;
    return;
  end if;

  perform 1
  from public.digests as digest
  where digest.digest_date = p_digest_date
    and p_item_id = any(digest.top5_item_ids);
  if not found then
    return query select
      'invalid_context'::text,
      null::uuid,
      null::uuid,
      null::date,
      null::text,
      null::timestamptz;
    return;
  end if;

  insert into public.feedback_token_redemptions (
    nonce_hash,
    token_version,
    digest_date,
    item_id,
    rating,
    expires_at,
    redeemed_at
  ) values (
    p_nonce_hash,
    p_token_version,
    p_digest_date,
    p_item_id,
    p_rating,
    p_expires_at,
    v_now
  )
  on conflict do nothing
  returning feedback_token_redemptions.redeemed_at into v_redeemed_at;

  if not found then
    return query select
      'already_redeemed'::text,
      null::uuid,
      null::uuid,
      null::date,
      null::text,
      null::timestamptz;
    return;
  end if;

  insert into public.feedback as current_feedback (
    item_id,
    digest_date,
    rating
  ) values (
    p_item_id,
    p_digest_date,
    p_rating
  )
  on conflict (item_id) do update set
    digest_date = excluded.digest_date,
    rating = excluded.rating
  returning current_feedback.id into v_feedback_id;

  return query select
    'recorded'::text,
    v_feedback_id,
    p_item_id,
    p_digest_date,
    p_rating,
    v_redeemed_at;
end;
$$;

revoke all privileges on function public.redeem_feedback_token(
  smallint, text, date, uuid, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.redeem_feedback_token(
  smallint, text, date, uuid, text, timestamptz
) to service_role;

comment on table public.feedback_token_redemptions is
  'One row per redeemed signed feedback choice; stores only SHA-256 nonce hashes.';
comment on function public.redeem_feedback_token(
  smallint, text, date, uuid, text, timestamptz
) is
  'After Web HMAC verification, atomically enforces digest membership, DB-clock expiry, replay prevention, and feedback persistence.';
