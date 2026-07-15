# Per-issue verification and code review log

Every completed issue must record: red test, implementation, targeted tests,
plan alignment check, reviewer findings, and final evidence. Entries are added
in remediation-plan order.

## BASE-01 — remove paper-station and keep Frontier only

- Red evidence: root Git remote was `Looperswag/paper-station`; the only loaded
  job was `com.paperstation.daily`; Frontier was an untracked nested repository.
- Implementation: unloaded and removed the old LaunchAgent; migrated private
  `.env` and the interest profile; moved two legacy digests under ignored
  `legacy/`; deleted only the root Paper Station whitelist.
- Targeted verification: the parent directory has no root `.git`, `backend/`,
  `web/`, `docs/`, Paper Station database, or Paper Station LaunchAgent.
  Frontier is the sole Git repository and retains the expected GitHub origin.
- Plan check: personal articles, PDFs, figures, scripts, and temporary research
  files remain outside the deletion whitelist.
- Code review: no production source changed; `.env` is ignored and mode 0600;
  `config/profile.md` and `legacy/` are ignored; no secret value was printed.
- Result: DONE.

## FRESH-01 — enforce source timestamp freshness

- Red evidence: arXiv already normalized dates, but HF/blog/GitHub values could
  be missing, malformed, stale, future-dated, or left in provider-specific
  formats; the ingest collector accepted all of them as fresh candidates.
- Implementation: the collector now applies one bounded two-day lookback and
  five-minute future-skew allowance to every normalized source item, records
  an explicit rejection reason in logs, drops missing/invalid/stale/future
  entries, and rewrites accepted timestamps to canonical ISO strings before
  ranking or persistence.
- Targeted verification: freshness unit tests pass 6/6, including each
  rejection reason, accepted boundary, canonicalization, and source-specific
  logging; ingest date integration tests pass 2/2; typecheck and lint pass.
- Plan check: this is a collector-level gate, so it covers arXiv/HF/blog and
  also hardens GitHub/X without changing source limits or ranking semantics.
  Source identity, historical novelty, and feed quality remain assigned to
  ID-01/NOVEL-01/BLOG-01.
- Independent review: checked clock usage against the locked Shanghai run
  instant, future-skew handling, RFC/ISO provider dates, and no-silent-drop
  logging. No unresolved correctness or privacy issue remains.
- Result: DONE.

## LLM-01 — bounded, validated, and injection-resistant LLM dispatch

- Red evidence: the previous rank parser accepted duplicate, out-of-range, and
  non-finite model entries after JSON parsing; malformed provider envelopes
  could strand a reservation; structured retries had no overall deadline; and
  source text was interpolated without an explicit data boundary. A failed
  summary also aborted the complete Top5 loop.
- Implementation: `completeJSON` accepts strict Zod schemas, retries only
  bounded structured-output failures, and enforces a 120-second abortable
  deadline on top of the 45-second provider timeout. Provider envelopes and
  usage are validated before settlement. Rank output now requires unique,
  bounded indexes, finite 0–100 scores, bounded rationales, deterministic
  tie-breaking, and a signal-based fallback. Profile, feedback, and source
  content are marked as untrusted data in prompts; summary fields are
  semantically validated and each item has a deterministic fallback with
  explicit degraded metadata.
- Targeted verification: focused LLM/rank/summary tests pass 16/16 after the
  final abort-envelope addition (15/15 before the final signal regression was
  added); the tests cover semantic-schema rejection, malformed provider
  envelopes, abort-before-reservation, duplicate/out-of-range indexes,
  deterministic Top-N completion, per-item summary isolation, and cache-key
  reuse. Root typecheck, lint, and diff-check pass.
- Plan check: this closes only explicit dispatch timeout/retry/deadline,
  semantic validation, bounded unique Top-N, and prompt data-boundary targets.
  Persistent summary cache/version storage and broader content provenance
  remain assigned to LLM-02/TEXT-01/DB-04b.
- Independent review: reviewed the provider-reservation lifecycle, abort
  cleanup, Zod bounds, deterministic tie-breaks, fallback metadata, and prompt
  boundaries. One additional malformed-envelope case was found and closed
  before recording this result; no unresolved P0/P1 issue remains in LLM-01.
- Result: DONE.

## LLM-02 — isolated summaries with versioned cache and degradation metadata

- Red evidence: `summarizeAll` awaited each item without isolation, so one
  provider/schema failure aborted the entire Top5; repeated runs had only an
  in-process cache and no persisted content/profile/prompt version identity.
- Implementation: each item now has strict output bounds and a deterministic
  abstract-based fallback marked `degraded` with a reason; successful results
  are cached by SHA-256 content/profile hashes plus `summary-v1`. The new
  server-only `summary_versions` table and RPCs persist immutable versions
  keyed by item FK, while cache outages remain non-fatal to the digest. The
  ingest runner passes the authoritative item-ID map so cache lookups happen
  before provider dispatch.
- Targeted verification: summary isolation/cache tests pass 4/4, the focused
  LLM/rank/summary suite passes 16/16, summary-version pgTAP passes 15/15,
  and the full DB RLS/schema/security gate remains green.
- Plan check: cached versions are never used for changed content, profile, or
  prompt versions; fallback output is not persisted as a successful cache
  entry. Historical digest snapshots remain separately governed by DB-04b.
- Independent review: checked hash inputs, item-ID mapping, stale-cache
  rejection, cache failure isolation, fallback metadata propagation, and
  bounded source abstract handling. No unresolved P0/P1 issue remains.
- Result: DONE.

## API-02 — distributed quotas and real dual-identity mutation acceptance

- Red evidence: deterministic database orchestration reproduced a `no_data_found`
  5xx when hot-path GC deleted an expired bucket between conflict upsert and
  the target lock; the Web transport review reproduced hidden OpenAI retries,
  unbounded/hanging chat streams, and production E2E login failure without a
  trusted test identity header. The real IDOR run initially also exposed that
  local Auth email login is intentionally disabled, so its negative login
  result is 503 rather than a fabricated 401.
- Implementation: sealed service-role RPCs now provide IP/user token buckets,
  project-global and subject LLM reservation/settlement ledgers, Shanghai-day
  accounting, bounded cleanup, deterministic lock ordering, request-id
  idempotency, and conflict-row locking (`ON CONFLICT DO UPDATE ... WHERE
  false`). Root rank/summary/refine dispatches reserve and settle their own
  physical provider attempts; Web chat disables SDK retries, propagates a
  deadline/cancel signal, bounds streamed bytes, and settles failed or
  unpersisted reservations. A mutation inventory and real local Supabase
  Playwright harness create two confirmed users without enabling signup.
- Targeted verification: focused DB RED/GREEN proved the GC race; the full
  `ALLOW_LOCAL_DB_RESET=1 npm run db:test` exited 0 with quota 77/77, outbox
  27/27, digest 60/60, feedback 30/30, schema 38/38, summary cache 15/15,
  digest history 11/11, final security 80/80, and
  schema lint clean. Root tests are 345/345. Web tests are 690/690; the
  chat deadline/cancel/size suite is 47/47, lint/typecheck/build pass, and
  regular Playwright E2E is 10/10. The real `npm run test:idor` is 8/8:
  all five owner-business mutations return 403 for a real non-owner while
  complete stable JSON snapshots of seven tables remain byte-identical;
  login and logout negative controls preserve session boundaries.
- Plan check: rate limits use only versioned HMAC IP subjects and verified
  UUIDs; service-role keys and quota ledgers remain server-only. The data model
  is explicitly single-owner, so this evidence proves global non-owner
  rejection, not multi-tenant row ownership. HTTP retry idempotency and a
  dedicated reservation-cancel RPC remain follow-up concerns under LLM/RUN
  reliability, not hidden claims of row tenancy.
- Independent review: database review found and closed the GC lock race and
  added synchronized concurrent starts plus owner-write and isolated Root
  subject-cap tests; Web review found and closed the SDK retry, stream deadline,
  output bound, cancel, and E2E identity findings; the IDOR review required
  and then observed the real dual-identity matrix and full-table snapshots.
- Result: DONE.

## OUTBOX-01 — leased, idempotent delivery state

- Red evidence: direct ServerChan POSTs had no durable attempt state, lease,
  idempotency key, crash recovery, or safe per-channel replay; a process crash
  after provider acceptance could either lose a delivery or duplicate both
  channels on manual resend.
- Implementation: the service-only `delivery_outbox` table is FK-backed by the
  digest date and has bounded payloads, provider/channel contracts, attempts,
  next-attempt timestamps, leases, terminal state, provider message id, and
  redacted error text. `enqueue_delivery` is idempotent, `claim_delivery` uses
  `FOR UPDATE SKIP LOCKED` and reclaims expired leases, and `finish_delivery`
  requires the lease owner before success/retry/permanent transitions. Root
  `pushDigest` enqueues configured channels and processes only claimed jobs.
- Targeted verification: outbox pgTAP passes 27/27, including duplicate
  enqueue, payload conflict, lease ownership, retry scheduling, terminal
  success/failure, provider mismatch, and invalid lease checks. Root outbox
  client tests pass 4/4; digest delivery tests pass 2/2; the full DB gate
  exits 0 with RLS/security, schema and concurrency checks green.
- Plan check: this changes delivery persistence only and leaves digest content
  immutable; a succeeded channel is never reclaimed while another channel can
  retry independently. An alert channel remains assigned to ALERT-01.
- Independent review: checked direct-table privilege revocation, empty
  search_path, FK cleanup, stale-lease reclaim, idempotency payload equality,
  bounded error storage, and provider/channel mismatch. One SQL ambiguity and
  one test-only role-leak path were found and closed; no unresolved P0/P1
  issue remains in the outbox atom.
- Result: DONE.

## EMAIL-01 — SMTP TLS multipart provider

- Red evidence: no email provider existed even though the requested product
  includes the 163 mailbox; direct push had no TLS timeout, multipart body,
  Message-ID tracking, or classified SMTP failure path.
- Implementation: optional complete SMTP configuration validates host/port,
  TLS mode, addresses, and server-only credentials. The provider enforces TLS
  1.2, 30-second connection/greeting/socket timeouts, multipart text/HTML,
  stable SHA-256-derived Message-ID and idempotency header, and classifies
  temporary SMTP/network responses for outbox retry. HTML is escaped from the
  Markdown text and secrets never enter errors.
- Targeted verification: SMTP unit tests pass 3/3 for TLS/timeouts, multipart
  escaping, stable Message-ID, optional configuration, and retry classes;
  config tests cover complete/partial/unsafe groups; outbox integration
  covers SMTP enqueue and lease completion.
- Plan check: SMTP remains opt-in so existing non-email deployments keep the
  ServerChan path; setting all seven SMTP variables enables the requested
  mailbox without exposing credentials to Web.
- Independent review: reviewed transport options, recipient validation,
  message-id determinism, HTML escaping, timeout boundaries, and error
  classification. No unresolved P0/P1 issue remains.
- Result: DONE.

## WX-01 — ServerChan delivery through the outbox

- Red evidence: ServerChan delivery previously accepted unbounded bodies,
  could hang indefinitely, treated malformed/non-business responses as success,
  and had no durable retry state.
- Implementation: both legacy Turbo and Server酱³ URL formats use the same
  claimed outbox job; requests have a 30-second abort, a 64 KiB response cap,
  strict JSON/business-code validation, safe provider errors, and retry
  classification for 408/429/5xx/network failures.
- Targeted verification: digest delivery tests pass 2/2 for successful email
  orchestration and oversized ServerChan response failure; the existing
  send-last suite passes 19/19 with the outbox RPC contract; DB outbox tests
  pass 27/27 and both key regexes remain covered by config tests.
- Plan check: provider retries are bounded and lease-backed; duplicate
  idempotency keys do not create new jobs. Independent alert delivery remains
  assigned to ALERT-01.
- Independent review: checked URL key routing, timeout cleanup, body bounds,
  JSON parsing, business-code validation, safe error text, and retry state
  transitions. No unresolved P0/P1 issue remains.
- Result: DONE.

## MD-01 — harden sanitized Markdown links

- Red evidence: the first Web unit test showed that `sanitize-html` removed the
  intended `target=_blank` and `rel=noopener noreferrer` attributes because the
  attribute allowlist did not permit them.
- Implementation: allow only the two generated attributes in addition to the
  existing link attributes; the transform still overwrites attacker-supplied
  values and the scheme allowlist remains `http`, `https`, and `mailto`.
- Targeted verification: six Vitest cases cover safe Markdown, script and event
  removal, mixed-case and entity/control-character `javascript:` variants,
  `data:`, and hostile `target`/`rel`; Web lint, typecheck, and diff-check pass.
- Plan check: the change is limited to the documented rendering trust boundary;
  it does not broaden permitted tags or URL schemes.
- Independent review: three review rounds found and then closed two test-only
  blind spots (attribute ownership and control-character URL normalization).
  Final review reported no unresolved implementation or test finding.
- Result: DONE.

## TIME-01 — lock run and feedback dates to Asia/Shanghai

- Red evidence: root and Web tests initially failed because no Shanghai date
  module existed; a consumer test then showed `saveFeedback` ignored its
  supplied instant; the orchestration review also required a cross-midnight
  integration test.
- Implementation: explicit Gregorian/Latin `Asia/Shanghai` date helpers; an
  immutable run-time snapshot that reads the clock once; `runIngest` dependency
  injection; all log, render, persistence, and push consumers reuse one date;
  feedback accepts an optional occurrence instant and persists its Shanghai day.
- Targeted verification: six root date tests, three Web date tests, one feedback
  persistence test, and two ingest integration tests cover UTC 16:00, year
  rollover, invalid dates, a single clock read, all four date consumers, dry-run
  failure logging, and a non-`Error` provider rejection object.
- Plan check: the remaining UTC truncation is GitHub's source lookback query,
  not a run/feedback date; no run-date call site remains outside the locked
  snapshot. Existing `saveFeedback` callers remain source-compatible.
- Independent review: the first review found missing orchestration protection;
  the second found one low-severity logging drift introduced by extraction.
  Both received failing regression tests and fixes. Final review reported no
  unresolved finding or behavior/API regression under UTC and Los Angeles TZs.
- Evidence: integration 2/2, contract 2/2, root full 15/15, Web full 10/10,
  both lint/typecheck runs, and `git diff --check` pass. Root coverage floor was
  ratcheted to 17/10/16/19 (statements/branches/functions/lines).
- Result: DONE.

## RUN-01 — durable run and source health ledger

- Red evidence: the collector had no durable date lease or source-level outcome;
  overlapping jobs could both write the same date, and a small candidate pool
  could overwrite or deliver over an existing digest.
- Implementation: `pipeline_runs` uses a Shanghai-date uniqueness lease with a
  six-hour stale-run recovery window; `source_runs` records succeeded/empty/
  failed counts and bounded errors. The ingest runner records all source
  outcomes, marks degraded runs when a source fails, and marks low-candidate
  runs skipped before item/digest/delivery writes or ranking and summarization.
- Targeted verification: ingest integration covers lease/source/finish
  orchestration and retryable low-candidate isolation; final pipeline pgTAP
  passes 60/60, including takeover audit preservation and old-token rejection
  for item, digest, delivery and finish side effects.
- Plan check: the ledger is service-role controlled and forced-RLS; dry runs
  never touch it. Independent alerting after a failed delivery remains ALERT-01.
- Independent review: checked stale-run recovery, duplicate-date locking,
  source upsert idempotency, bounded errors, and failed-run completion paths.
- Result: DONE.

## DB-04b — historical digest item summaries

- Red evidence: `summaries` was a latest-item projection, so a later rerun
  could replace the exact text/score shown by an older digest; no digest-item
  FK or bounded historical content relation existed.
- Implementation: `digest_items` stores each digest's rank, score, model and
  bounded summary fields with digest/item FKs, forced RLS, and no direct API
  grants. A postgres-owned summary trigger captures newly persisted bundle
  rows; migration and seed backfills are idempotent and preserve existing
  snapshots. Check constraints reject empty/oversized historical content.
- Targeted verification: history pgTAP passes 11/11, including seed backfill,
  exact bundle preservation, direct-DML denial, rejected content rollback;
  schema 38/38 and security 80/80 pass in the full database gate.
- Plan check: the current latest projection remains for compatibility while
  historical reads are protected from summary replacement; no RAG/full-text
  behavior is implied.
- Independent review: checked trigger ordering during atomic bundle writes,
  seed replay, FK deletion policy, conflict idempotency, and RLS/grant scope.
- Result: DONE.

## SOCIAL-01 — remove disabled social-source stubs

- Red evidence: X was listed as a source but always returned an empty array;
  its weight could make a disabled provider appear part of source coverage.
- Implementation: removed the X fetcher, X/Facebook weights, and X from the
  production fetcher registry. The ingest ledger now sees only configured
  arXiv, Hugging Face, GitHub, and blog sources.
- Targeted verification: Root full tests 345/345, typecheck, lint, and diff
  check pass; no runtime path imports or advertises the removed provider.
- Plan check: this intentionally removes the social source rather than
  pretending a provider contract exists; adding one later requires an explicit
  feature flag and health contract.
- Independent review: checked source registry, weights, docs/config references,
  and candidate threshold behavior after the source count change.
- Result: DONE.

## COMPLY-01 — source compliance registry

- Red evidence: source URLs and retention/rate assumptions were scattered in
  fetchers, with no machine-checked active-source inventory; Google Scholar
  could be mistaken for a supported unattended source.
- Implementation: `SOURCE_REGISTRY` now records official URL, robots policy,
  rate boundary, license/attribution expectation, and retained data for every
  active source. X/Facebook and Scholar are absent from the registry and docs
  explicitly prohibit Scholar scraping.
- Targeted verification: source-registry unit coverage passes alongside Root
  346/346 tests; lint, typecheck, and diff-check pass.
- Plan check: registry metadata does not claim legal permission beyond honoring
  each publisher's terms; it documents the operational boundary only.
- Independent review: checked registry/source ID alignment, removal of disabled
  providers, and retention wording against README/SPEC.
- Result: DONE.

## DEP-01 — pinned runtime and dependency hygiene

- Red evidence: supported Node versions and dependency update ownership were
  implicit, making local/CI drift likely even though installs used lockfiles.
- Implementation: both package manifests declare Node `>=20.19.0 <26`, the
  repository pins the recommended major in `.nvmrc`, npm lockfiles remain the
  single install source, and weekly Dependabot updates cover root and Web.
  Root and Web production audits report zero vulnerabilities.
- Targeted verification: clean package-lock-only regeneration, Root/Web tests,
  lint/typecheck/build, and both `npm audit --omit=dev` runs pass.
- Plan check: no runtime dependency was upgraded solely for this metadata
  change; the prior nodemailer vulnerability fix remains pinned in the root
  lockfile.
- Independent review: checked engine compatibility with CI, lockfile paths,
  Dependabot directories, and documentation commands.
- Result: DONE.

## TENANCY-01 — explicit single-owner ADR

- Red evidence: the product was single-owner in code and docs but had no ADR,
  leaving future readers to infer unsupported tenant isolation guarantees.
- Implementation: added `docs/adr/0001-single-owner-boundary.md` documenting
  owner authentication, service-only system rows, forced RLS, and the exact
  boundary before multi-tenant work would be safe.
- Targeted verification: existing real IDOR run remains 8/8 with five owner
  business mutations denied to a real non-owner; Root/Web tests and DB RLS
  gates pass.
- Plan check: this records the current boundary and does not claim multi-user
  support; future tenant columns/RLS remain a separate migration.
- Independent review: checked ADR statements against auth middleware, service
  role grants, and IDOR harness cleanup behavior.
- Result: DONE.

## SCHED-01 — deterministic launchd scheduling

- Red evidence: launchd templates invoked `npm` through a shell PATH, allowed
  overlapping jobs, appended unbounded logs, and had no doctor or plist lint
  gate.
- Implementation: scheduled jobs now use an absolute Node executable, a
  mkdir-based per-job lock with stale-PID recovery, 5 MiB × 3 log rotation,
  and a shared `run-scheduled.sh` wrapper. The installer validates Node and
  runs `plutil -lint` when available; `npm run doctor` checks runtime,
  lockfiles, `.env` permissions, and templates.
- Targeted verification: doctor version tests cover supported/unsupported
  runtimes; shell syntax and Root lint/typecheck/test suites pass. The
  installer refuses Desktop/Documents/Downloads TCC paths before writing jobs.
- Plan check: launchd remains local-only; the pipeline date lease prevents
  duplicate writes, while a future cloud catch-up scheduler remains CLOUD-01.
- Independent review: checked shell quoting, absolute path substitution,
  stale-lock recovery, bounded rotation, and plist placeholder integrity.
- Result: DONE.

## RANK-01/RANK-02 — bounded recall, signal-aware rerank, and diversity

- Red evidence: ranking sent the entire candidate pool directly to the model,
  fallback scoring reused raw stars, and a high-scoring source/topic could
  monopolize Top5 without offline quality checks.
- Implementation: deterministic recall keeps the top 100 candidates by
  source weight, log engagement, star velocity and recency before LLM rerank;
  fallback and model completion pass a deterministic MMR-like selector with
  source/topic caps. Precision@5/NDCG helpers and a fixed relevance fixture
  guard quality floors.
- Targeted verification: rank/diversity tests, offline fixture, Root test suite,
  lint and typecheck pass; ties are resolved by canonical external ID.
- Plan check: the LLM remains responsible for profile relevance; deterministic
  recall/diversity only bounds and stabilizes its candidate set.
- Independent review: checked index mapping after recall truncation, duplicate
  prevention, cap fallback when one source is the only available source, and
  metric denominator behavior.
- Result: DONE.

## GH-01 — velocity and release-aware GitHub source

- Red evidence: one stars-sorted query repeatedly returned evergreen projects;
  new repositories and release activity were not distinguished.
- Implementation: each topic now has bounded `created` and `pushed` searches;
  the top active repositories receive a single latest-release lookup. Items
  carry star velocity, newness, release tag/link and release timestamp, with
  deterministic velocity/recency sorting before the global ranker.
- Targeted verification: GitHub response contract remains strict, velocity
  tests pass, and Root full tests/lint/typecheck pass.
- Plan check: release enrichment is bounded to ten repositories per run and
  uses the existing HTTP retry/timeout policy; source failure remains isolated.
- Independent review: checked token handling, topic failure indexing, release
  validation, API call bounds, and deterministic tie-breaks.
- Result: DONE.

## BASE-02 — reproducible quality, coverage, CI, and browser-test baseline

- Red evidence: root lint/coverage and Web test/E2E scripts were absent; the
  four commands exited with missing-script errors. The original five tests only
  loaded `normalize.ts`, Web had no tests, and build required undeclared env.
- Implementation: Vitest/V8 coverage for both packages, Testing Library/jsdom,
  flat ESLint configs, root unit/contract/integration scripts, Chromium
  Playwright, deterministic fake Supabase data, fast/full verify scripts, and
  two-job GitHub Actions CI on Node 24. Existing Node tests were migrated without
  changing their assertions.
- Targeted verification: clean `npm ci` succeeds in both packages; root contract
  2/2, integration 2/2, full 15/15; Web full 10/10; Chromium E2E renders a seeded
  digest/date/title/summary and leaves no server process. Both lint/typecheck,
  production build with test config, audits, and diff-check pass at their
  documented gates.
- Coverage truthfulness: unimported production files remain in the denominator;
  current ratcheted floors are root 21/14/17/23 and Web 3/2/4/3 for
  statements/branches/functions/lines. Web explicitly includes `middleware.ts`
  and future `proxy.ts`. The final gate remains at least 80% globally.
- Plan check: production-like provider fixtures, local Supabase/pgTAP, and fault
  injection remain explicitly in BASE-03 rather than being implied by this
  baseline. Moderate Next/PostCSS advisories and lockfile/root warnings remain
  visible under DEP-01.
- Independent review: the first pass found missing coverage thresholds, omitted
  auth middleware, an outage-as-empty E2E false positive, and overly broad lint
  exceptions. Each was corrected and independently rerun; final review reported
  no BASE-02 blocker.
- Result: DONE.

## BASE-03 — production-like fixtures and fault-injection baseline

- Red evidence: provider transport initially lacked controllable timeout,
  retry, body, and validation seams; database migrations had no executable
  empty/legacy/RLS test path; concurrent local DB runs reproduced container
  deletion and reset corruption; and a deliberate future-table grant plus an
  unprotected new public table were not covered by the original matrix.
- Implementation: deterministic run clock and HTTP `now`/`random`/`sleep`/
  `fetch` injection; queue-based providers and injected ingest fetchers;
  fixed relational Supabase/E2E fixtures; exact-version local Supabase;
  pgTAP schema and dynamically enumerated RLS/grant/default-ACL tests; real
  anon/auth denial and service-role CRUD; legacy upgrade, repeated empty reset,
  same-database seed replay, schema lint, destructive-reset guard, and an
  atomic process lock for DB tests.
- Targeted verification: controlled mutation of future-table SELECT produced
  `not ok`; adding an unprotected public table expanded the dynamic plan from
  37 to 41 and failed its RLS assertion. A concurrent runner exits 3 before
  touching Docker. The serial database matrix exits 0; root has seven files
  and 60 tests, contracts 10/10 and integrations 3/3; lint, typecheck, Bash
  syntax, and diff-check pass.
- Plan check: adapter-specific RSS/Atom/query/mapping fixtures remain assigned
  to ARXIV-01, BLOG-01, GH-01, and FRESH-01. This baseline supplies the fake
  seams and failure controls without claiming those source semantics are done.
- Independent review: the initial review found missing future-table coverage,
  hard-coded public-table lists, no true role behavior, and a shared Docker
  race. Each gap received a test or mutation probe and was closed. Final review
  mapped every BASE-03 acceptance target to executable evidence and found no
  blocker.
- Result: DONE.

## DB-01 — repeatable Supabase migration workflow

- Red evidence: no executable migration path initially existed. Early pgTAP
  runs exposed a future-function default-ACL hole, and concurrent local runs
  reproduced container removal/reset corruption. Review also found no same-DB
  seed replay, incomplete TAP parsing, and cleanup gaps.
- Implementation: an exact Supabase CLI version now upgrades legacy `0002`,
  performs two empty rebuilds, replays seed twice in one database, compares the
  migration list, runs schema/security/role tests and lint, rejects an existing
  instance, serializes runners with a stale-safe lock, and always cleans up a
  test-owned stack. README and CI use the same complete migration workflow.
- Targeted verification: the final independent run exited 0 with 101 pgTAP
  assertions (legacy security 37, schema 27, final security 37), real role
  behavior, migration-list parity, schema lint, seed idempotency, and no
  remaining container, volume, or lock. TAP mutation/parser checks reject
  `not ok`, bad/missing plans, and `Bail out!`.
- Plan check: no hosted project was linked or mutated. Remote version/history/
  drift inventory and Security Advisor remain an explicit release canary, not
  a claim made by local migration tests.
- Independent review: three rounds closed seed, cleanup, parser, default ACL,
  future object, dynamic table, role behavior, and concurrency findings. Final
  review found no code blocker and marked DB-01 ready.
- Result: DONE.

## DB-02 — RLS and least-privilege grants

- Red evidence: initial tables had no RLS/grant migration; later review proved
  schema-scoped function REVOKE could not cancel PostgreSQL's global PUBLIC
  EXECUTE default. Controlled mutations of a future-table anon grant and a new
  public table without RLS both produced `not ok` failures.
- Implementation: all current and future public tables revoke every API/service
  privilege before granting service-role CRUD only; sequences grant service
  USAGE/SELECT only; schema CREATE is revoked; future functions created by the
  migration owner globally revoke API/PUBLIC EXECUTE; every application table
  has RLS enabled. Server service-role modules keep explicit `server-only`
  boundaries.
- Targeted verification: tests dynamically enumerate all permanent public base
  and partitioned tables; inspect all eight table privileges, sequence/schema/
  function defaults, and future probes; then exercise anon/auth query denial
  and service-role insert/select/update/delete in a rolled-back transaction.
- Plan check: the model remains intentionally single-owner/server-admin for now;
  Supabase Auth ownership isolation is tracked separately by AUTH-01 and
  TENANCY-01.
- Independent review: final review reran the complete database matrix and found
  exact current/future grants, true role behavior, RLS, and secret boundaries
  correct. Hosted schema-drift inventory remains a release canary only.
- Result: DONE.

## HTTP-01 — bounded, validated provider HTTP client

- Red evidence: the first adversarial suite exposed retrying deterministic
  status failures, no body-size/schema boundary, unsafe transport causes, and
  missing attempt accounting. Independent review then reproduced five deeper
  defects: body aborts became false "empty body" errors, synchronous aborts
  could hang or start another attempt, default backoff timers survived caller
  cancellation, URL credentials/invalid headers reached transport paths, and
  response cancellation could block forever. The expanded RED run failed 15
  tests and rejected five malformed provider payloads.
- Implementation: one bounded client now validates HTTP(S) URLs and headers
  before transport; strips query/transport details from errors; applies
  per-attempt timeout plus overall deadline; retries only network failures,
  408, 429, and 5xx with bounded jitter/`Retry-After`; makes caller abort win
  every race; clears default timers; caps streamed bytes; and performs
  non-blocking best-effort body cleanup. GitHub and Hugging Face validate both
  top-level and per-element business shapes before mapping.
- Targeted verification: 36 HTTP tests and eight provider contract cases pass,
  including hanging fetch/body/cancel, body-network failure, synchronous abort
  in both retry hooks, timeout budget exhaustion, Retry-After, jitter bounds,
  content type/length/stream limits, credentials, malformed headers/JSON, and
  secret redaction. Root full tests are 59/59; lint, typecheck, coverage, and
  `git diff --check` pass on the working tree.
- Plan check: the work stays within shared HTTP/provider transport validation;
  provider-specific ranking, freshness, and partial-batch policy remain in
  their dedicated source issues. Malformed provider elements intentionally
  fail the batch closed.
- Independent review: two rounds reproduced and closed the response-body,
  backoff, cleanup, credential, and element-validation races. Final Node 25 and
  Node 24 runs both passed 44/44 targeted cases; manual probes confirmed two
  timeout attempts, one caller-aborted attempt, no lingering timer, no blocking
  cancel, and no query/cause leakage. No correctness or security blocker
  remains. `http.ts` coverage is 90.08% statements, 78.94% branches, 89.47%
  functions, and 92.89% lines; the root floor is ratcheted to 52/45/39/54.
- Result: DONE.

## CFG-01 — typed, fail-closed runtime configuration

- Red evidence: configuration tests first reproduced missing/unknown targets,
  canonical/legacy conflicts, unsafe or symlinked env files, public secret
  aliases, malformed URLs/keys, secret-bearing errors, inherited/file value
  conflicts, environment snapshot races, partial deployment sync, demo writes,
  a demo development preflight that incorrectly required DeepSeek, and short or
  placeholder GitHub tokens. Deployment and E2E regressions also reproduced a
  changed source env after preflight and service-role exposure checks across
  generated assets.
- Implementation: immutable typed capability loaders now cover root and Web;
  Node's env parser plus a descriptor-based 0600/owner/no-symlink reader feeds
  one AsyncLocalStorage snapshot; legacy aliases migrate with mode-0600 backups
  and explicit deprecations; errors redact configured, encoded, bearer, and
  provider-shaped secrets; all root consumers and cached clients bind to the
  active snapshot. Preflight gates every command, cron install, Web development,
  and production deploy. Deployment validates and uploads one immutable
  whitelist snapshot, clears absent remote values, and production access modes
  fail closed. Demo development validates data but does not require a private
  LLM key, while private/local development still does.
- Targeted verification: the final root suite passes 19 files and 146 tests;
  Web passes five files and 39 tests. Both lint/typecheck runs, Bash syntax, and
  `git diff --check` pass. Clean lockfile installs pass. Root coverage is
  69.64/64.97/66.82/72.23 and Web coverage is
  28.25/37.00/18.18/29.44 (statements/branches/functions/lines); floors are
  ratcheted to 69/64/66/72 and 28/37/18/29 respectively. A production build and
  Chromium E2E pass; the E2E asserts deterministic content and scans the HTTP
  response, DOM, loaded scripts, and every `.next/static` asset for the service
  role sentinel. Web Vitest uses one worker after a multi-fork startup failure;
  this changes scheduling only and leaves all assertions and coverage intact.
- Live/config canary: `dry` preflight succeeds; `ingest` preflight safely stops
  on the genuinely unavailable Supabase URL/service key; live dry collection
  exits zero with arXiv 30, Hugging Face 40, GitHub 25, blogs 40, and 134
  deduplicated candidates, without persistence or delivery. The isolated dead
  Anthropic feed remains assigned to BLOG-01.
- Plan check: no hosted config, database, Vercel project, email, or WeChat state
  was mutated. Missing hosted Supabase credentials are reported rather than
  fabricated. The retained legacy aliases remain warnings for compatibility;
  auth ownership, dependency advisories, feed health, and reliable delivery stay
  in their dedicated rows.
- Independent review: repeated adversarial passes found and closed env
  race/leakage, cached-client, migration-mode, deployment snapshot, demo write,
  static-secret scan, demo-predev, GitHub-token, E2E navigation, and test-worker
  findings. Final narrow reviews found no correctness, security, privacy,
  compatibility, or test-strength blocker.
- Result: DONE.

## DB-03 — checked database results and truthful UI (complete)

### DB-03a — exact item-upsert acknowledgement

- Red evidence: five initial failures proved that an empty batch created a
  client, partial/extra/invalid results were accepted, and provider details
  escaped. Review then reproduced duplicate input-key collapse and identified
  duplicate returned keys/IDs plus whitespace/non-UUID IDs; three new cases
  failed before the follow-up fix.
- Implementation: empty batches are database-free; input primary keys must be
  unique before connection; provider failures become typed, detail-free
  operation errors; returned rows must be an exact key-set match with unique,
  canonical UUID IDs.
- Verification and plan check: target plus client-context/ingest adjacency pass
  14/14; lint, typecheck, and diff-check pass. The change is limited to DB-03
  acknowledgement semantics; DB-04a later supplied transactionality.
- Independent review: first review found the duplicate-key/ID gaps; all received
  regression coverage. Final review found no correctness, leakage, type, or
  compatibility blocker.
- Sub-result: REVIEWED.

### DB-03b — checked summary replacement

- Red evidence: empty input opened a client; missing/duplicate mappings reached
  SQL; delete errors were ignored; insert errors escaped raw; and partial insert
  acknowledgements were accepted. All five behaviors failed the new tests.
- Implementation: item mappings are complete, unique UUIDs before connection;
  delete and insert results are checked and selected back. Deletes may report
  zero, some, or repeated old rows only within the requested ID scope; inserts
  must acknowledge the exact unique ID set.
- Verification and plan check: summary/root-ingest adjacency passes 18/18 and
  the focused suite passes 17/17; lint, typecheck, and diff-check pass. The
  two-statement replace was explicitly non-atomic and was removed when DB-04a
  replaced it with the atomic bundle RPC.
- Independent review: review found no implementation blocker and requested two
  boundary tests. Legal repeated old rows and rejected out-of-scope delete rows
  are now locked; final review marked the sub-result ready.
- Sub-result: REVIEWED.

### DB-03c — distinguish empty behavioral signals from query failure

- Red evidence: annotation/chat/feedback provider errors and null data all
  became empty arrays; malformed rows manufactured blank metadata. Five tests
  failed. Review then reproduced silent first-row selection for an impossible
  multi-row many-to-one relation; two isolated relation tests failed.
- Implementation: each query result is checked before the next query; only a
  real empty array is empty. Rows and relation fields are validated against the
  public return types, and relation arrays must contain exactly one item.
- Verification and plan check: root result/ingest adjacency passes 28/28; lint,
  typecheck, and diff-check pass. This changes only failure truthfulness, not
  feedback scoring, retention, or profile policy.
- Independent review: the first pass found the multi-row relation gap and
  coupled malformed fixtures. Null/multi-row cases are now isolated and a
  valid single-element array is covered; final review found no blocker.
- Sub-result: REVIEWED.

### DB-03d — exact digest persistence without false delivery state

- Red evidence: missing/duplicate mappings, null or mismatched acknowledgements,
  provider failure, and a pre-written `emailed_at` produced seven failures.
  Review then proved empty and over-five digests persisted; both boundary tests
  failed before the follow-up fix.
- Implementation: digest size must be 1–5 and mappings complete before
  connection. The upsert omits delivery timestamps, selects one row back, and
  verifies date, ordered IDs, and Markdown byte-for-byte.
- Verification and plan check: result/ingest adjacency passes 37/37; lint,
  typecheck, and diff-check pass. Immutable snapshots and atomic summaries were
  later completed by FB-01e/DB-04a; OUTBOX-01 still owns delivery state, and RUN-01 owns
  candidate quality and minimum-health policy.
- Independent review: it confirmed PostgREST merge omission preserves an old
  field rather than nulling it, then found the empty-digest gap. The 1–5 guard
  is now database-free on failure; final review found no blocker.
- Sub-result: REVIEWED.

### DB-03e — latest-digest absence versus corruption

- Red evidence: provider failure escaped raw; empty Markdown was reported as no
  row; invalid/null dates reached delivery. Four tests failed. Review then found
  astronomical year zero was accepted; its dedicated case failed.
- Implementation: `maybeSingle` null alone means absence. Existing rows require
  a PostgreSQL-compatible Gregorian date key and nonblank Markdown before push;
  database failures are typed and detail-free.
- Verification and plan check: send/preflight/error adjacency passes 22/22;
  lint, typecheck, and diff-check pass. Tests lock descending date order, limit
  one, and `maybeSingle`; delivery state remains OUTBOX-01.
- Independent review: all requested blank/invalid-calendar/year-zero/query-chain
  boundaries were added; final review found no blocker.
- Sub-result: REVIEWED.

### DB-03f — truthful Web Top5 read model

- Red evidence: digest/items/summaries/feedback failures became empty or partial
  UI, malformed digest looked absent, and missing summaries were tolerated;
  five tests failed. Review then reproduced digest-order loss and out-of-range
  ranks; two tests failed. A deploy-root import contract also first failed on a
  parent-directory shared import.
- Implementation: digest date and 1–5 ordered unique UUIDs are validated; items
  and summaries must exactly match; feedback is an optional checked subset;
  digest order is authoritative and rank must equal its one-based position.
  Web keeps a local server-only DB-result module so Vercel's `web/` upload root
  has no parent import.
- Verification and plan check: boundary contract 1/1, Web data adjacency 20/20,
  lint, typecheck, diff-check, and a production Next build pass. The change does
  not add auth or alter ranking policy; it makes stored snapshot inconsistencies
  visible.
- Independent review: all requested digest/summary/rating matrices and deploy
  packaging boundary were closed; final review found no blocker.
- Sub-result: REVIEWED.

### DB-03g — deterministic paper detail and archive history

- Red evidence: detail reads accepted an arbitrary summary; archive reads could
  lose newer rows by applying the limit before item-level deduplication. Invalid
  timestamps, duplicate summary IDs, provider failures, and incomplete item
  joins were also exercised as integrity failures.
- Implementation: detail selects the latest historical summary by
  `created_at DESC, id DESC`. Archive pages through the same stable order,
  validates canonical summary IDs/timestamps, rejects repeated history IDs,
  keeps the newest row per item, and only then applies the requested unique-item
  limit and exact item join.
- Verification and plan check: the focused Web result suite passes 34/34;
  ESLint and typecheck pass. Tests now directly lock wrong latest-summary item
  references, malformed latest timestamps, duplicate archive summary IDs,
  multi-page deduplication, stable query ordering, and exact referenced items.
  Concurrent offset-pagination drift remains assigned to DB-04b rather than
  being hidden by this read-integrity fix.
- Independent review: no P0/P1 correctness blocker remained. The reviewer’s P2
  coverage requests for duplicate IDs and malformed/misassociated latest rows
  were added and pass.
- Sub-result: REVIEWED.

### DB-03h — checked chat and annotation histories

- Red evidence: provider failures and null data were manufactured as empty
  histories; arbitrary rows were cast into UI types; chat history selected the
  oldest 60 records; ties were nondeterministic; malformed anchors could break
  the renderer. The initial matrix failed 18/52 cases, and follow-up ordering,
  input-ID, and over-limit cases failed 4/56 plus 1/62.
- Implementation: both reads use typed database results, validate UUIDs,
  requested-item association, timestamps, unique IDs, stable timestamp/UUID
  order, and exact public DTOs. Chats fetch the latest 60 descending and return
  them chronologically. Annotation anchors share renderer-safe validation for
  highlight/note/pen/box, including finite coordinates and nonnegative sizes;
  the same contract now rejects invalid new annotations before any DB call.
- Verification and plan check: the focused suite passes 63/63 and locks
  provider redaction, null-versus-empty, wrong relations, microseconds,
  equivalent timezone instants, UUID tie-breaks, response limits, all four
  valid/invalid anchor shapes, color/body, DTO stripping, and query chains.
  Web full tests previously passed 95/95; lint, typecheck, and diff-check pass
  after the implementation. Hosted legacy rows cannot be audited without the
  genuinely missing Supabase credentials; corrupt old rows fail closed rather
  than being hidden.
- Independent review: the first pass found the read/write anchor mismatch and
  requested deeper order/shape locks. Shared write-time validation and every
  requested boundary were added; final review found no P0/P1 and approved the
  sub-result.
- Sub-result: REVIEWED.

### DB-03i — exact Web mutation acknowledgements

- Red evidence: feedback/chat/delete ignored every Supabase result; annotation
  threw raw provider errors and cast unknown rows. The dedicated mutation suite
  initially failed 20/20. Review then reproduced PostgreSQL UUID lowercase and
  JSONB `-0` normalization after a successful write; four uppercase cases failed
  before the follow-up fix.
- Implementation: feedback upsert and chat/annotation insert select one row
  back and verify canonical UUIDs, timestamps, relations, and the complete
  normalized payload. Annotation anchors use JSON-semantic deep equality and
  return an explicit public DTO. Delete selects affected IDs and distinguishes
  absent, malformed/multiple, mismatched, provider-failed, and exact-one-row
  outcomes. All UUID inputs are canonicalized before query/payload construction.
- Verification and plan check: mutation tests pass 45/45 and read-result tests
  pass 66/66; Web full tests pass seven files and 150 tests. Lint, typecheck, and
  diff-check pass. Tests isolate note/date validation, null/array/multiple
  acknowledgements, every business-field mismatch, uppercase UUIDs, JSONB
  numeric/key normalization, typed error redaction, and fluent query order.
  HTTP/UI presentation remains explicitly assigned to DB-03j.
- Independent review: the first pass found UUID and `-0` post-write false
  failures plus acknowledgement coverage gaps. Canonicalization and all
  requested matrices were added; final review found no P0/P1/P2.
- Sub-result: REVIEWED.

### DB-03j — truthful HTTP and client mutation outcomes

- Red evidence: clients treated non-2xx feedback/chat/delete responses as
  success; chat persisted partial or empty upstream completions; history
  failures looked like empty state; path changes allowed old streams to race
  new paper state. Follow-up RED cases also reproduced duplicate deletes,
  malformed success envelopes, finish-marker protocol violations, and the
  history/send race.
- Implementation: routes now map checked database failures to generic non-2xx
  responses and only acknowledge exact successful results. Chat requires an
  explicit `stop`, nonblank complete output, no choice after the finish marker,
  and successful assistant persistence. Clients validate response status and
  DTO/envelopes, expose failure states, gate sends until history is loaded,
  cancel stale requests/readers by generation, update stable turn IDs, and
  prevent duplicate feedback or per-annotation deletes.
- Verification and plan check: the six focused route/component suites pass
  46/46; Web full tests pass 13 files and 198 tests; Web lint, typecheck, and
  coverage pass at 80.64% statements, 73.67% branches, 76.19% functions, and
  84.27% lines. Root tests pass 22 files and 192 tests; root lint, typecheck,
  `git diff --check`, production build, static-secret scan, and Chromium E2E
  pass. Authentication, shared schemas/CSRF, feedback token replay, and
  database transactionality remain explicitly assigned to later plan items.
- Independent review: the first pass found three P1 history/path/persistence
  truthfulness gaps and several P2 concurrency/protocol/envelope gaps. Every
  finding received a failing regression test and fix. Final review found no
  P0/P1/P2 blocker and approved the whole DB-03 result.
- Sub-result: REVIEWED. DB-03 result: DONE.

## AUTH-01 — Supabase Auth single-owner authorization (in progress)

### AUTH-01a — fail-closed typed Auth configuration

- Red evidence: a complete legacy Basic configuration was accepted without an
  owner or publishable Auth credential. Review-driven cases then reproduced a
  production demo exposing service-role reads, missing Auth URL capability,
  opaque/malformed service-role keys, invalid email dot-atoms, incomplete
  production issue reporting, duplicate feedback issues, and a development
  server bound beyond loopback. The matrices failed 10/41 plus the isolated
  dev-binding contract before their fixes.
- Implementation: production now requires normalized `AUTH_OWNER_EMAIL`, a
  publishable/legacy-anon key, Supabase URL, service-role data key, DeepSeek,
  and the transitional private gate. The Auth capability independently returns
  only URL, publishable key, and owner email. Production demo is rejected;
  local demo is loopback-only and `next dev` binds `127.0.0.1`. Key roles,
  owner email dot-atoms, complete unique issues, deployment snapshot keys, CI,
  examples, and documentation are all checked without logging values.
- Verification and plan check: focused config/middleware/binding tests pass
  42/42; deployment/CI/env contracts pass 9/9. Root full tests pass 192/192;
  Web coverage passes 14 files and 211 tests at 80.93% statements, 74.82%
  branches, 76.41% functions, and 84.50% lines. Root/Web lint, typecheck,
  `git diff --check`, production build, secret scan, and private-mode Chromium
  E2E pass. This establishes configuration and network boundaries only; session
  verification, DAL/API/page enforcement, login/logout, and Auth E2E remain in
  later AUTH-01 sub-items.
- Independent review: the first pass found two P1 capability/demo failures and
  P2 validator/reporting gaps; the second found stale demo documentation and a
  Host-header development bypass. Each received a failing regression and fix.
  Final review found no remaining P0/P1/P2 blocker.
- Sub-result: REVIEWED.

### AUTH-01b — pure single-owner authorization decision

- Red evidence: the owner decision module did not exist. The initial matrix
  then exposed missing official credential classifications; review-driven RED
  cases proved expired/audience-invalid sessions became 503, impossible dates
  and `24:00` were accepted, and malformed anonymous/role fields became 403.
  The successive focused failures were 4/20, 1/21, and 9/30 before fixes.
- Implementation: a server-only pure decision converts a fresh Auth result into
  a frozen, minimal branded owner context only for the exact normalized,
  confirmed owner with canonical UUID, explicit non-anonymous flag, and
  `authenticated` role. Missing/expired/invalid credentials map to generic 401;
  explicit bans/verification failures and non-owner identities map to 403;
  provider failures, malformed shapes, and impossible timestamps map to 503.
  Provider detail, metadata, and PII are never propagated.
- Verification and plan check: the final focused matrix passes 33/33, including
  official Supabase error codes, metadata impersonation, UUID case, strict
  Gregorian/microsecond/offset timestamps, and malformed schema types. Web full
  tests pass 15 files and 241 tests; lint, typecheck, and `git diff --check`
  pass. Coverage passes at 81.72% statements, 76.22% branches, 77.22%
  functions, and 85.30% lines. This sub-item intentionally performs no cookie
  I/O or route enforcement; every later context must be created from a real
  `auth.getUser()` result rather than deserialized or asserted.
- Independent review: it found the official error-code drift and strict
  timestamp/schema boundaries. Every finding received a failing regression and
  fix; final review found no remaining blocker and approved the phantom brand
  only as a compile-time boundary.
- Sub-result: REVIEWED.

### AUTH-01c — request-scoped verified owner session

- Red evidence: there was no cookie-aware Auth client or shared `requireOwner`.
  The new contract initially failed at module resolution and required exact
  publishable-key construction, request cookie reads, `getUser` use, generic
  thrown-failure handling, 401/403 preservation, and static exclusion of
  `getSession` and admin credentials.
- Implementation: the exact-pinned `@supabase/ssr@0.12.0` client is created
  inside a React request cache from the typed Auth URL and publishable key. It
  reads the current Next cookie store, calls fresh `auth.getUser()`, and passes
  only that result to the reviewed owner decision. Known authorization errors
  retain their generic status; configuration, cookie, construction, and
  network exceptions become detail-free 503 responses at the caller boundary.
- Verification and plan check: owner/session tests pass 40/40;
  `@supabase/ssr@0.12.0` is exact in the manifest/lock and `npm ls` is clean.
  Web full tests pass 16 files and 251 tests; lint, typecheck, diff-check, and
  coverage pass at 81.91% statements, 76.45% branches, 77.45% functions, and
  85.46% lines. This verifier remains deliberately unused until Proxy refresh
  support is complete.
- Independent review: no sub-item blocker remained. Per-request construction,
  React cache semantics, server-only isolation, publishable/admin separation,
  cookie reads, `getUser`, and generic errors were approved. Review established
  a hard activation prerequisite: before any page/route calls this verifier,
  a full-coverage Proxy must synchronize refreshed request/response cookies and
  propagate the SSR library's `Cache-Control`, `Expires`, and `Pragma` headers;
  expired-session integration tests must prove no cross-request sharing or
  repeated refresh.
- Sub-result: REVIEWED.

### AUTH-01d — Next 16 Proxy session refresh and cookie isolation

- Red evidence: no Next 16 Proxy or real SSR refresh path existed. The initial
  suite failed at module resolution. Independent review then reproduced a
  development-private 503 caused by missing Auth capability, and rejected the
  mock-only refresh proof required by AUTH-01c. Both received dedicated RED
  coverage before implementation/integration fixes.
- Implementation: `middleware.ts` is replaced by a full-route `proxy.ts` that
  preserves the transitional private gate, removes the anonymous feedback
  exception, creates a publishable SSR client per accepted request, calls
  `getClaims` only for refresh, synchronizes request and response cookies, and
  copies every SSR cache-prevention header. Local demo remains read-only and
  loopback-bound; development private loads only the Auth capability. Refresh
  exceptions return generic 503 and no identity decision trusts Proxy claims.
- Verification and plan check: Proxy unit and real SSR integration tests pass
  14/14. The integration uses the actual `@supabase/ssr` cookie codec and fake
  Auth HTTP: an expired token rotates once, the returned cookie avoids a second
  refresh, concurrent distinct sessions do not cross, and a revoked refresh
  token writes `Max-Age=0`/no-store and is not retried after removal. Root Web
  boundary contracts pass 4/4; Web full coverage passes 17 files and 260 tests
  at 82.28% statements, 76.50% branches, 78.09% functions, and 85.71% lines.
  Lint, typecheck, diff-check, production build, and Chromium E2E pass; the
  deprecated middleware warning is gone.
- Independent review: the first pass found the development-private capability
  bug and required real expired/revoked integration rather than manual mock
  callbacks. Final review reran all 14 refresh tests and found no P0/P1/P2
  blocker in per-request construction, cookie/header propagation, isolation,
  matcher coverage, or publishable/admin separation. Final page/API owner
  enforcement remains a later AUTH-01 sub-item.
- Sub-result: REVIEWED.

### AUTH-01e — public-safe root and URL-transparent private route group

- Red evidence: the root layout imported and rendered the private paper list
  and chat panel for every route, so a future public login page would execute
  service-role-backed reads before authentication. The initial boundary test
  failed because `app/(private)/layout.tsx` and the grouped pages did not exist.
  After the move, an isolated typecheck also reproduced stale `.next/types`
  references to the old page paths.
- Implementation: the root layout now contains only global presentation and
  `children`. The existing shell, paper list, and chat panel live in
  `(private)/layout.tsx`; home, paper, and search pages moved into the same
  URL-transparent route group without behavior changes. The Web typecheck now
  runs Next's native `typegen` before `tsc`, so route moves cannot leave stale
  generated validators behind. The boundary test renders the real public root
  but intentionally inspects the private layout contract without synchronously
  rendering its async Server Components.
- Verification and plan check: the focused boundary suite passes 3/3; Web full
  tests pass 18 files and 263 tests; root tests pass 22 files and 192 tests.
  Web coverage passes at 82.39% statements, 76.50% branches, 78.19% functions,
  and 85.83% lines. Lint, regenerated typecheck, `git diff --check`, targeted
  production-source credential/session scans, CI-configured production build,
  and Chromium E2E pass. The build manifest preserves `/`, `/paper/[id]`, and
  `/search` with no `(private)` URL segment.
- Independent review: final review found no P0/P1/P2 blocker and approved both
  the route boundary and `next typegen` repair. It explicitly confirmed that a
  route-group name is organization, not authorization; owner-session checks on
  every private page and API remain required before the transitional Basic gate
  can be removed.
- Sub-result: REVIEWED.

### AUTH-01f — bounded single-owner login and local-session logout

- Red evidence: `/login` and both Auth routes did not exist, while Proxy placed
  every request behind the transitional Basic gate. Initial route/form tests
  failed at module resolution and the public path matrix failed. Browser RED
  then exposed Next's internal URL differing from the external Host. The first
  independent review reproduced two P1 gaps: an undeclared body was fully
  buffered before the 4 KiB check, and hanging Auth calls prevented completion
  and could prevent local logout. It also found ambiguous forwarded-host trust,
  missing real chunk coverage, and a UTF-8/UI size mismatch.
- Implementation: a public login page asks only for a password. Same-origin,
  form-only POST uses the configured owner email and a request-local publishable
  SSR client, then authorizes only a fresh `getUser()` result. Auth responses
  preserve every SSR cookie and anti-cache header; cookies are HttpOnly,
  SameSite=Lax, Secure on HTTPS, and never use service-role credentials. Invalid
  identity clears the newly issued session. Logout is POST-only, local-scope,
  fixed-redirect, and clears every project cookie chunk even when remote revoke
  fails. Body reads stop and cancel above 4 KiB; password size is 1024 UTF-8
  bytes; Auth operations and their fetches have an eight-second deadline/abort.
  Origin uses the HTTP Host plus forwarded protocol and rejects a conflicting
  `X-Forwarded-Host`. Proxy exposes only exact login GET/HEAD and Auth POSTs;
  all business resources remain behind Basic until AUTH-01g.
- Verification and plan check: focused unit/real-SSR review tests pass 53/53,
  including hung operations, no-length streams, non-owner cleanup, concurrent
  sessions, and real multi-chunk round-trip/removal. Web full tests pass 21
  files and 302 tests; root tests pass 22 files and 192 tests. Web coverage is
  83.79% statements, 77.58% branches, 80.16% functions, and 86.95% lines.
  Zero-warning lint, regenerated typecheck, diff-check, production build,
  static secret scan, and three Chromium login/digest journeys pass. Production
  dependency audit reports no high-severity advisory; the two moderate PostCSS
  findings remain assigned to DEP-01 because npm's suggested force fix is a
  breaking downgrade.
- Independent review: the first pass rejected the sub-item for the two P1 and
  three P2 gaps above. Every finding received a failing regression and fix.
  Final review reran the boundary suite and found no remaining P0/P1/P2 blocker.
  It approved this only as a session-lifecycle prerequisite: page/API owner
  enforcement and removal of Basic/`APP_PASSWORD` remain AUTH-01g.
- Sub-result: REVIEWED.

### AUTH-01g1 — owner enforcement for every private render entry

- Red evidence: `requireOwner` existed but no production page called it. The
  root/private split alone could not prevent Next partial rendering from
  executing a child data read. The new matrix initially resolved private JSX
  and invoked service-role functions instead of stopping at authentication.
- Implementation: a server-only boundary converts missing/forbidden sessions
  into a fixed `/login` redirect and verifier failures into a generic error.
  Private layout, Home, Paper, Search, and the async PaperList each invoke it
  independently before params, search params, or any data read. The private
  layout now contains a POST-only current-session logout form. The global error
  boundary renders a fixed recovery message and never displays `error.message`.
- Verification and plan check: the render matrix covers 401/403/503 across all
  five entry points and proves every downstream data spy remains zero. Actual
  Chromium owner login followed by the digest page covers the successful Home
  and PaperList path. Basic remains an outer transitional gate, so this atomic
  step only strengthens the deployable intermediate state.
- Independent review: final review found no P0/P1/P2 blocker in auth-first
  ordering, partial-render defense, redirect behavior, or error disclosure.
- Sub-result: REVIEWED.

### AUTH-01g2 — owner enforcement for every business API

- Red evidence: annotations, chat, export, and feedback accepted direct calls
  without invoking the reviewed owner verifier. The initial eight-handler
  matrix reached body/URL/params parsing and downstream work. It also exposed
  that daily digests still issued replayable signed feedback URLs that the new
  owner boundary would deliberately reject, while comments/examples continued
  to call those links anonymous.
- Implementation: every business GET/POST/DELETE calls `authorizeAPI()` before
  input parsing, params, DB, LLM, signing, or DOCX. 401/403/503 bodies are fixed
  and include private no-store, Expires, Pragma, and Vary headers. Auth login
  and logout remain the only public mutation routes. Digest rendering no longer
  creates signed feedback links; root/Web examples and route comments mark the
  old format as owner-only compatibility until FB-01. Markdown and Word export
  retain explicit successful-owner coverage.
- Verification and plan check: eight handlers × three auth outcomes prove
  exact status/body/headers and zero calls to data, DeepSeek, signing, or Packer.
  Existing annotation/chat/feedback success suites plus two export success
  cases preserve business behavior. The latest full Web coverage passes 25
  files and 321 tests at 87.79% statements, 80.23% branches, 86.00% functions,
  and 90.87% lines; root passes 23 files and 194 tests. Root/Web lint,
  typecheck, diff-check, production build, and three Chromium journeys pass.
- Independent review: it first found stale anonymous-feedback claims and a
  missing export success proof. Both received regression coverage and fixes.
  Final review found no remaining P0/P1/P2 blocker.
- Sub-result: REVIEWED.

### AUTH-01g3a — branded owner capability at every privileged service boundary

- Red evidence: service-role database and DeepSeek exports previously accepted
  calls without an owner capability, and their clients/configuration were
  initialized without tying use to a verified request. The compile-time
  contract initially failed every intended owner-first call and then protected
  every legacy missing-owner signature plus a structurally similar plain DTO.
- Implementation: all ten DAL exports and the DeepSeek client require the
  branded `OwnerContext` returned only by the reviewed Auth decision. Every
  page, component, and API call site propagates that value. The service-role
  client is created once and lazily only after input validation and capability
  arrival; importing either privileged module reads no secret or creates no
  client.
- Verification and plan check: compile-time positive/negative capability
  contracts cover all eleven exports; runtime tests prove import and rejected
  input cannot initialize privileged clients, a valid operation creates one
  reusable database client, and chat/export propagate the exact owner. Web
  full tests pass 26 files and 325 tests; lint, regenerated typecheck,
  production build, and `git diff --check` pass.
- Independent review: the first pass found one P2 false-green risk because
  missing-owner negative examples covered only three exports. Negative
  contracts were expanded to every privileged function and the reviewer
  reran typecheck and 27 focused tests. Final review found no remaining
  P0/P1/P2, no alternate cast/deserialization path, no eager secret access,
  and no bypassing privileged client export.
- Sub-result: REVIEWED.

### AUTH-01g3b — hard client recovery from an expired private session

- Red evidence: private Client Components treated a 401 like an ordinary
  mutation/load failure, leaving private in-memory state rendered after the
  server had rejected the session. The helper test initially failed because no
  centralized private fetch boundary existed.
- Implementation: one client-only same-origin fetch helper hard-navigates to
  the fixed `/login` path on exactly 401, returns all responses to the caller,
  and never retries. Chat history/send, feedback, and annotation create/delete
  all use it; the public login request deliberately remains outside it.
- Verification and plan check: tests cover success, 401, 403, 503, and network
  failure, assert one transport call and one fixed redirect, and statically
  enumerate all five private client API call sites. Component regressions and
  Web full tests pass 27 files and 329 tests; lint, regenerated typecheck,
  production build, and `git diff --check` pass.
- Independent review: the reviewer scanned every production client fetch and
  reran five focused files (31 tests), lint, typecheck, and diff-check. It found
  no P0/P1/P2, no retry, open redirect, cross-origin target, response-detail
  leak, or private call outside the helper.
- Sub-result: REVIEWED.

### AUTH-01g4 — Supabase-session Proxy cutover

- Red evidence: the transitional Proxy still granted access from a correct
  HTTP Basic header, returned one response shape for pages and APIs, and could
  wait forever on a hanging Auth provider. The new cutover matrix initially
  failed all ten session outcomes; browser RED also exposed an unconditional
  fake `/auth/v1/user`, colliding parallel tokens, a service-role-blind REST
  fixture, and a render-blocking Google Fonts dependency.
- Implementation: Basic parsing/challenge is gone. Exact public Auth methods
  remain public; protected pages redirect anonymously to fixed `/login`, APIs
  return fixed 401, valid canonical claims continue optimistically, and unknown,
  malformed, thrown, timed-out, or caller-aborted Auth states return generic
  503. One operation signal bounds `getClaims` and its transport to eight
  seconds, propagates request cancellation, preserves cookie mutations, and
  applies private anti-cache headers to every result. Final page/API guards
  remain authoritative. Test Auth sessions and refresh tokens are unique and
  isolated; Auth and REST fixtures now validate exact issued/service-role
  credentials. The root layout uses local system font stacks only.
- Verification and plan check: Proxy unit/real refresh/cutover tests cover
  missing, credential, valid, malformed, outage, timeout, abort, cookie
  rotation/removal, unissued bearer, request isolation, and no Basic source.
  Chromium covers anonymous page/API, legacy Basic, login, wrong password,
  digest, logout, parallel-session isolation, and service-role denial. Web full
  passes 28 files and 343 tests; lint, regenerated typecheck, build, and
  diff-check pass. Standard E2E passes 8/8 and four-worker repeat-each=3 passes
  24/24 after the external-font availability regression was removed.
- Independent review: two P1 rounds found the unbounded Proxy operation,
  token/logout cross-talk, false-positive fixtures, and external font DCL hang.
  Every finding received a failing regression and fix. Final review reran 55
  focused tests and the 24-journey stress test and found no remaining P0/P1/P2.
- Sub-result: REVIEWED.

### AUTH-01g5 — remove Basic/demo configuration and migrate deployment

- Red evidence: production still required `APP_PASSWORD`, client code retained
  a public demo switch, CI/examples/deploy uploaded both obsolete variables,
  signup remained enabled, and the initial deployment cleanup swallowed every
  Vercel list/removal failure. Mutation tests proved the script would continue
  a production deployment after a failed or no-op obsolete-key deletion.
- Implementation: access modes are password-free private/local capabilities;
  production and non-loopback are private, while loopback development only
  skips Proxy refresh and still reaches final owner guards. Supplying either
  obsolete key fails by key only. The demo module/UI/CSS are deleted; CI,
  Playwright, env examples, current docs, and active code contain no old access
  setting. Supabase disables global/email signup and anonymous identities,
  requires confirmed email and a 12-character strong password. Deployment
  lists production variables, deletes an obsolete key only when present,
  verifies its absence, uses `env add --force` for current values, and stops on
  list, removal, no-op postcondition, or deployment failure without a separate
  promotion. It never reads or uploads old values.
- Verification and plan check: runtime/preflight/CI/example/source contracts,
  deploy harness, and Supabase policy tests pass. The harness covers first and
  post-delete list failure, removal failure, successful no-op removal, snapshot
  mutation, invalid preflight, and failed deployment. Root full passes 24 files
  and 204 tests; Web full passes 28 files and 343 tests. Both lint/typecheck,
  Bash syntax, build, diff-check, E2E 8/8, and E2E stress 24/24 pass.
- Independent review: it initially found the fail-open Vercel deletion and a
  stale demo comment, then requested postcondition/list-failure mutations.
  All were fixed. Final review found no P0/P1/P2 in runtime, active source,
  Supabase policy, deployment ordering/rollback, examples, CI, or docs.
- Sub-result: REVIEWED.

### AUTH-01 final result

- Every private render entry, business API, service-role/LLM call, client
  recovery path, Proxy decision, configuration mode, and deployment migration
  now requires or preserves the reviewed single-owner Auth boundary.
- Result: DONE.

## API-01 — bounded, same-origin, schema-validated business APIs (done)

### API-01a — shared request/response boundary and annotations

- Red evidence: authenticated cross-origin POST/DELETE requests could mutate
  annotations; JSON bodies were buffered without a byte bound; duplicate,
  unknown, malformed UUID, anchor, coordinate, array, and extra fields reached
  the DAL; notes were silently truncated; and success/error responses lacked a
  complete private header contract. The first adversarial run failed 24 cases.
  Follow-up REDs proved hostile cancellation and caller abort could hang, and
  review exposed an auth-error header gap plus an Origin-order test that watched
  an obsolete parser rather than actual stream consumption.
- Implementation: Zod 4.4.3 is a direct exact dependency. Shared request code
  validates the exact external Origin, JSON media type/encoding/declared length,
  streams at most 32 KiB with fatal UTF-8 decoding, bounds depth/nodes, rejects
  duplicate/unknown query keys, and makes cancellation/abort non-blocking.
  Shared responses enforce private no-store, Expires, Pragma, case-insensitive
  `Vary: Cookie, Origin`, nosniff, and fixed error envelopes. Annotation input is
  a strict four-way discriminated union with canonical UUID, color, coordinate,
  geometry, point/rect, body, and encoded-anchor bounds; nothing is truncated.
  GET/POST/DELETE authorize first; mutations check Origin before body/query and
  map database not-found/operation/integrity failures to fixed 404/503/500.
- Verification and plan check: byte streams with zero high-water mark prove
  Origin and 401/403/503 auth decisions perform zero pulls and zero DAL calls.
  Tests cover hostile cancel, caller abort, invalid UTF-8, 4097 nodes, excessive
  depth, 20 KiB anchor, content types/encoding/length, forwarded host/protocol,
  every annotation shape, query ambiguity, response headers, and Vary merging.
  Focused review passes five files and 75 tests. Web full passes 30 files and
  388 tests; lint, regenerated typecheck, production build, and diff-check pass.
- Independent review: the first pass found the missing auth response hardening
  and false-green body-order spy. Both received real stream/header regressions
  and fixes; optional Host delimiter/node/anchor cases were also added. Final
  review found no remaining P0/P1/P2.
- Sub-result: REVIEWED.

### API-01b — bounded, truthful chat history and streaming

- Red evidence: chat accepted ambiguous/non-UUID queries and unbounded or
  cross-origin JSON; unknown fields and untrimmed messages reached persistence;
  operational failures returned inconsistent bodies and private streaming
  responses lacked the complete header contract. The request-boundary suite
  initially failed 17 of 31 cases. Independent review then found two
  false-green gaps: authorization failures did not prove zero body reads, and
  status-only error assertions did not lock the shared envelope or headers.
- Implementation: GET authorizes before exact query parsing and validates one
  canonical UUID. POST authorizes, rejects unsafe origins before reading the
  body, accepts only bounded 8 KiB UTF-8 JSON, and validates a strict object
  with a trimmed 1..2000-code-point/8192-byte message. Database, missing-paper,
  and pre-stream LLM failures use fixed shared errors. A successful text stream
  is private/no-store and persists an assistant turn only after an explicit
  `stop`, nonempty content, and confirmed database write; partial, truncated,
  post-finish, upstream, or persistence failures terminate the stream without
  manufacturing an assistant record.
- Verification and plan check: 401/403/503 hostile byte streams prove zero
  pulls and zero DAL/LLM calls. Tests cover media/encoding/size, duplicate and
  unknown query keys, strict UUID/body/message validation, normalization,
  database mapper branches, fixed error envelopes and headers, empty history,
  owner propagation, and every complete/incomplete streaming outcome. The
  focused suite passes 36/36; the Web suite passed 30 files and 404 tests before
  the review-only assertions were added. Typecheck, lint, and diff-check pass.
- Independent review: the first pass rejected the two test-truthfulness gaps
  above. Both received real regressions. Final review reran the focused suite,
  typecheck, lint, and target diff-check and found no remaining P0/P1/P2.
  Orphaned user-turn UX and provider/prompt deadlines remain explicitly owned
  by UX-01 and LLM-01.
- Sub-result: REVIEWED.

### API-01c — strict, private export API boundary

- Red evidence: export accepted malformed path IDs, ambiguous/unknown formats
  and query keys, silently treated unsupported formats as Markdown, let DAL and
  DOCX exceptions escape, returned a plain-text not-found response, and omitted
  private headers on successful attachments. Fifteen of sixteen focused cases
  failed initially. Independent review then found that auth-first ordering and
  non-disclosure assertions could still pass false implementations.
- Implementation: after authorization, strict Zod schemas canonicalize the path
  UUID and permit exactly one optional `format=md|docx`; only an absent format
  defaults to Markdown. Paper and annotation reads short-circuit in order and
  map known operation/not-found plus integrity/unknown failures to fixed shared
  errors. Packing failures return a fixed private 500. Both Markdown and DOCX
  attachments preserve their content headers and pass through the shared
  no-store/Expires/Pragma/Vary/nosniff hardener.
- Verification and plan check: invalid/empty/unsupported/duplicate/unknown
  input cannot reach the DAL or packer; uppercase UUIDs reach both DAL calls in
  one canonical form; paper, annotation, and packing failures prove downstream
  short-circuiting and fixed messages. An auth-failure test uses throwing,
  observable URL and params objects to prove neither is inspected before the
  owner decision. Focused export plus owner enforcement pass 23/23, with
  typecheck, lint, and diff-check also passing. Document sanitization, real PDF,
  fonts, pagination, and render verification remain assigned to EXPORT-01.
- Independent review: the first pass rejected weak auth-order and arbitrary
  message assertions. Both were replaced with mutation-killing regressions.
  Final review found no remaining P0/P1/P2 in API-01c.
- Sub-result: REVIEWED.

### API-01d — bounded owner feedback mutation

- Red evidence: the owner feedback POST accepted cross-origin and unbounded
  JSON, malformed IDs, extra fields, blank/oversized/untrimmed notes, and
  inconsistent response bodies; twenty of twenty-five route cases failed.
  The DAL also silently truncated a 501-character note instead of rejecting it.
- Implementation: POST now follows authorization, same-origin, bounded 4 KiB
  JSON, strict Zod schema, then DAL order. IDs are canonical UUIDs; rating is an
  exact enum; a note is null or trimmed, nonblank, at most 500 Unicode code
  points/2048 UTF-8 bytes. Shared fixed responses map not-found/operation/
  integrity-or-unknown failures to 404/503/500. The DAL independently accepts
  only canonical bounded note input and persists it exactly without slicing.
- Verification and plan check: auth 401/403/503 and unsafe origins use hostile
  zero-high-water byte streams to prove zero body pulls and zero writes. Tests
  cover media type, content encoding, declared size, strict fields, canonical
  normalization, exact owner payload, mapper branches, fixed messages, complete
  private headers, and DAL acknowledgement. Focused tests pass and the full Web
  suite passes 30 files and 445 tests; typecheck, lint, and diff-check pass.
  The legacy signed GET remains explicitly assigned to FB-01.
- Independent review: confirmed request ordering, shared reader guarantees,
  strict schema and DAL behavior, fixed errors, and hardened success responses;
  no P0/P1/P2 remains in API-01d.
- Sub-result: REVIEWED.

### API-01 final result

- Every annotations, chat, export, direct owner-feedback, and signed-feedback
  mutation now authorizes before parsing, enforces the shared same-origin and
  bounded-schema boundary, maps database/provider failures to fixed private
  envelopes, and verifies exact persistence acknowledgements.
- Independent final review found no remaining P0/P1/P2 in API-01. The separate
  distributed rate-limit and LLM budget work remains explicitly owned by
  API-02 rather than being implied by this result.
- Result: DONE.

## FB-01 — confirm-then-consume signed feedback (done)

### FB-01a — versioned, expiring feedback token protocol

- Red evidence: the previous Root/Web implementations signed only
  `itemId:rating`, truncated HMAC-SHA256 to 16 hex characters, used ordinary
  string equality, and carried no digest date, expiry, or replay nonce. A new
  protocol suite first failed because the codec did not exist. Review then
  found signer/verifier closure gaps for 9/11-digit and negative epoch values;
  each boundary received a failing cross-runtime regression.
- Implementation: v1 is a strict seven-segment token binding canonical digest
  date, lowercase UUID, rating, deterministic fixed-policy expiry, a 32-byte
  HMAC-derived digest/item nonce shared by both rating choices, and a full
  32-byte domain-separated HMAC in canonical Base64URL. Tokens are byte-bounded;
  verification recomputes nonce, expiry policy, and signature, uses fixed-width
  `timingSafeEqual`, and returns frozen claims. The signer rejects any date whose
  derived expiry is not a positive canonical safe integer. A SHA-256 fingerprint
  supports storage without the raw token. Root signs; Web verifies; a frozen
  known-answer fixture prevents cross-project drift.
- Verification and plan check: tests cover every claim/signature mutation,
  malformed/legacy tokens, canonical Base64URL and integer forms, exact expiry,
  invalid clocks/secrets/config, deterministic nonce separation, stable
  fingerprints, and years spanning the 9/10/11/12-digit epoch boundary. The
  digest still emits no links and the old owner-only route grants no anonymous
  capability. Root focused tests pass 27/27 and Web focused tests pass 47/47;
  both typechecks, lints, and diff-check pass. After moving the physical repo
  outside Desktop and reinstalling both lockfiles, the Web verifier passes again
  from a clean dependency tree.
- Independent review: independently recomputed the fixture with Node crypto,
  ran 14,103 Root/Web differential cases, and forced three closure rounds for
  non-10-digit and negative epochs. Final review found no remaining P0/P1/P2.
- Sub-result: REVIEWED.

### FB-01b — atomic one-time redemption ledger

- Red evidence: no database-backed replay ledger or atomic redemption existed;
  concurrent requests could not distinguish first use from replay. Follow-up
  review also proved that the initial DAL accepted a structurally forged claims
  object and that a failed background race session could leave test fixtures.
- Implementation: a sealed, forced-RLS redemption table stores only a SHA-256
  nonce fingerprint and has a unique digest/item action. A service-role-only,
  `SECURITY DEFINER` RPC validates database time and digest membership, records
  one redemption, and upserts feedback in the same transaction while preserving
  an existing note. Web verification returns an opaque type backed by a
  module-private `WeakSet`; the DAL rejects plain DTOs, spread clones, and type
  assertions before opening the database client. The database race harness
  always waits for both sessions and has explicit plus EXIT-trap cleanup.
- Verification and plan check: pgTAP covers schema, grants, expiry, context,
  replay, note preservation, and transaction rollback. Two independent
  PostgreSQL sessions produce exactly `recorded` plus `already_redeemed` and one
  ledger/feedback row. Web verifier/DAL tests pass 85/85; the type contract is
  included by `tsc`; lint, typecheck, Bash syntax, database tests, and
  diff-check pass. Confirmation UI, POST route, and digest issuance remain the
  next FB-01 atoms.
- Independent review: the first pass found the forgeable structural claims and
  incomplete failure cleanup. Both received failing regressions and fixes. The
  final pass found no P0/P1/P2 and approved the atom.
- Sub-result: REVIEWED.

### FB-01c — bounded, same-origin login return preservation

- Red evidence: anonymous pages discarded their exact destination, while the
  login form used cached router navigation. The first focused suite failed 24
  cases. Review rounds then reproduced reflected-Host login redirects, encoded
  and dot-normalized API paths returning 307, malformed percent escapes born in
  later decode layers, incorrect multibyte length handling, C1 controls,
  oversized encoded API paths, and excessive decode depth. Browser trace also
  proved that a global `no-referrer` header changed the native logout form to
  `Origin: null` and caused a real 403.
- Implementation: one browser/server-safe classifier accepts only a bounded
  UTF-8 page path with one leading slash and its query. It fails closed across
  bounded percent-decoding layers and rejects absolute/protocol-relative URLs,
  backslashes, Unicode controls, fragments, malformed or invalid UTF-8 escapes,
  and case/encoding/dot variants of `/api`, `/login`, and `/_next`. Proxy API or
  invalid targets receive a fixed 401. Page redirects carry exactly one
  normalized `returnTo`; production builds the login URL from validated
  `WEB_BASE_URL`, never the request Host. The login page validates again and
  supplies noindex/no-referrer metadata; the form posts only the password and
  calls document-level `location.replace` only after the login response
  resolves successfully. Referrer policy is scoped to login/anonymous redirect
  responses so authenticated same-origin forms keep a usable Origin.
- Verification and plan check: tests cover UTF-8 4096-byte boundaries, arbitrary
  and excessive encoding depth, nested malformed escapes, C0/C1/DEL controls,
  path/query fidelity, duplicate parameters, trusted redirect origin, fixed API
  denial, pending login requests, defensive client validation, and exact server
  props. Focused tests pass 96/96; full Web passes 36 files and 597 tests. The
  final successful browser run passes 9/9 including exact path/query return and
  logout; typecheck, full lint, and tracked/untracked diff-check pass.
- Independent review: successive passes found the Host reflection, API
  classification gaps, layered parser gaps, bounded-work issue, and the
  over-broad referrer header. All received failing regressions and fixes. Final
  review finds no remaining P0/P1/P2 in FB-01c.
- Sub-result: REVIEWED.

### FB-01d — owner confirmation page and one-time POST redemption

- Red evidence: the legacy signed GET verified and wrote feedback during page
  navigation; no confirmation page or dedicated redemption POST existed. New
  route/component/page suites initially failed because those entry points were
  absent, and review later exposed a UI contradiction that showed both “not
  recorded” and “recorded”.
- Implementation: the old GET authorizes and returns a fixed 410 without
  parsing or writing. `/feedback` authorizes before inspecting its one bounded
  token, verifies without side effects, and renders an inert confirmation.
  `/api/feedback/redeem` follows auth, Origin, bounded JSON, strict schema,
  HMAC verification, opaque-claims DAL, and exact acknowledgement order.
  Recorded, replayed, expired/context-invalid, provider, and integrity states
  map to fixed non-leaking responses. The client enters a settled terminal
  state only for an exact success or the defined replay result.
- Verification and plan check: tests prove auth/Origin zero-read behavior,
  invalid/expired zero-write, no GET write, strict size/media/schema handling,
  exact owner/claims propagation, replay mapping, no false UI success, and
  removal of contradictory text. Focused suites, typecheck, lint, and
  diff-check pass. Digest issuance and login return preservation are separate
  FB-01 atoms.
- Independent review: the first pass found only the contradictory client copy;
  a two-case failing regression and settled-state fix closed it. Final review
  reported no P0/P1/P2 and approved the atom.
- Sub-result: REVIEWED.

### FB-01e — deterministic issuance, immutable context, and safe resend

- Red evidence: the digest still emitted legacy click-to-write GET links; an
  upsert could replace the same day's item/token context after links had been
  sent; and `push:last` blindly reissued stored Markdown after expiry, secret
  rotation, origin changes, or partial link corruption. Review then reproduced
  an empty-array validation hole, non-canonical origin false rejection, a
  deploy path that accepted Root/Web feedback-config mismatches, a CI contract
  that borrowed variables across workflow steps, and a logically green
  database gate exiting 1 during Supabase telemetry shutdown.
- Implementation: digest rendering now requires the typed feedback capability
  and emits deterministic v1 up/down confirmation URLs bound to date, ordered
  item IDs, fixed expiry, nonce, and full HMAC. An immutable snapshot RPC first
  established exact inserted/existing/conflict semantics; DB-04a later replaced
  its write access with the service-role-only atomic summary/digest bundle RPC.
  A trigger rejects later date/item/Markdown updates. The Root DAL accepts only
  an exact acknowledgement. `push:last` reloads date, ordered IDs, and Markdown, then
  requires exactly two current-origin/current-secret/unexpired links per item
  in order; legacy GET, remapped, partial, duplicated, rotated, or expired
  content fails before delivery. Vercel deployment snapshots Web config and
  compares it with a securely read `ROOT_ENV_FILE` using `target all` before
  the first remote call. The database gate disables only Supabase CLI telemetry.
- Verification and plan check: Root full and coverage runs pass 26 files and
  259 tests at 80.85% statements/82.83% lines; Web full and coverage runs pass
  36 files and 597 tests at 90.81% statements/92.91% lines. Production build,
  both typechecks and lints, Bash syntax, and diff-check pass. The complete
  database gate exits 0 across legacy upgrade, two empty rebuilds, pgTAP
  suites (48/48, 60/60, 30/30, 27/27, 48/48), role denial, two independent
  concurrency races, and schema lint. Deployment mutations prove both feedback
  mismatches make zero Vercel calls without disclosing values; workflow
  mutations prove build configuration cannot borrow feedback values from the
  coverage step.
- Independent review: successive passes found mutable token/DB mapping, blind
  resend, origin canonicalization, SQL array validation, deployment consistency,
  CI test truthfulness, and telemetry-exit gaps. Every finding received a
  regression and a fail-closed fix. Final review found no remaining P0/P1/P2 in
  FB-01e; outbox idempotency, provider retry, and delivery-state tracking remain
  explicitly assigned to OUTBOX-01/WX-01 rather than hidden in this atom.
- Sub-result: REVIEWED.

### FB-01 final result

- Signed feedback is now an expiring, constant-time-verified capability that
  opens an owner-only confirmation page, preserves a bounded same-origin login
  return, and is consumed exactly once by an atomic database transaction.
  Issuance, storage context, production configuration, and resend all fail
  closed against replay, drift, legacy links, and expiry.
- Result: DONE.

## DB-04a — atomic summaries and immutable digest bundle

- Red evidence: final publish review found that ingest deleted and reinserted
  summaries before asking the immutable digest RPC to accept the same-day
  snapshot. A conflicting rerun therefore failed only after changing summaries;
  the private homepage could then reject their ranks against the original
  digest. Focused regressions failed because the runner still called the
  separate summary writer and the DAL still invoked the snapshot-only RPC.
- Implementation: `store_digest_bundle` validates one-to-five aligned summary
  arrays, ordered integer ranks, PostgreSQL-range integer scores, unique existing
  item IDs, and bounded Markdown. A transaction advisory lock serializes bundle
  writers. First insert stores the digest and replaces its summaries in one
  transaction; exact existing bundles return without writes; conflicts return
  without touching either relation; any summary error rolls back the digest and
  restores prior summaries. A bundle older than the latest stored date is
  rejected before the existing-snapshot branch, so a delayed job cannot replace
  current summaries or continue into stale delivery. The Web homepage now reads
  its digest, ordered items, exact summaries, and ratings from one service-role-
  only SQL RPC and therefore one MVCC snapshot instead of several HTTP queries.
  The old snapshot-only RPC and direct service-role
  insert/update/delete on `summaries` and `digests` are revoked; trusted reads
  and the new postgres-owned, empty-search-path RPC remain available. The dead
  direct summary DAL and runner dependency were removed.
- Verification: the Root suite passes 26 files and 282 tests at 81.78%
  statement/84.10% line coverage; the Web suite passes 38 files and 604 tests
  at 90.95% statement/93.06% line coverage. The complete database gate exits 0
  across legacy upgrade, two clean rebuilds, pgTAP suites
  (48/48, 60/60, 30/30, 27/27, 48/48), role
  denials, feedback and digest two-session races, and schema lint. Digest pgTAP
  proves exact no-op, conflict summary preservation, duplicate-row resistance,
  explicit null-array rejection, stale-date rejection, actual service-role RPC
  access, consistent bundle reads, and forced summary-insert rollback of both
  relations. Root/Web lint and typecheck, the production build, 10 Playwright
  tests, and diff-check pass.
- Plan check: DB-04a is complete. FK-backed digest items and historical summary
  versions remain explicitly scoped to DB-04b rather than being implied here.
- Independent review: the review required explicit NULL handling, per-position
  exactness, direct-DML revocation, dead-API removal, integer/rank validation,
  stale-date ordering, and closure of the multi-query read TOCTOU. Each concern
  received a regression, permission assertion, or E2E credential matrix before
  the final database pass; no unresolved P0/P1/P2 remained.
- Result: DONE.

## DOC-01 — truthful, concise onboarding and product boundaries

- Red evidence: the prior README advertised an anonymous demo, full-text/all-
  paper search, original-paper annotation, automatic profile evolution, and a
  one-file migration path that did not match the private owner-only product.
  Package metadata still named Claude and nightly email, and launchd guidance
  embedded another user's absolute path. The first rewritten draft also
  overstated the archive as 500 items, implied every weekly refine run produced
  a suggestion, declared Node 20.9 sufficient despite the ESLint 10 engine, and
  omitted the deploy script's Root ServerChan preflight requirement.
- Implementation: README, SPEC, Web and launchd guides now use the actual
  scripts and distinguish a 60-item summarized archive from a 500-item AND
  substring search over title/abstract/generated summary fields. They state
  that no email, PDF full-text ingestion, vector/RAG search, X/Facebook source,
  anonymous demo, source-health store, freshness gate, delivery outbox, or
  automatic retention/delete workflow exists. Profile generation documents the
  three-signal threshold, feedback-only scope suggestion, and that
  `refine:apply` regenerates before applying. Setup uses every migration,
  separate mode-0600 Root/Web environments, one confirmed owner, matching
  feedback configuration, a stable non-File-Provider path, and the real deploy
  and verification commands. Root/Web package descriptions and environment
  examples no longer advertise obsolete providers or behavior.
- Privacy and reliability disclosure: the guides enumerate what stays in the
  user's Supabase project, what is sent to DeepSeek and ServerChan (including
  signed feedback links), and which source/delivery failures remain best-effort
  and visible only in logs. Server-only key boundaries and disabled public
  signup/anonymous access are explicit without implying that RLS alone supplies
  end-user tenancy.
- Targeted verification: environment, auth-cutover, CI Web configuration,
  preflight, and deploy-preflight suites pass 30/30 across five files. Both
  shell guides parse, both package manifests parse, forbidden legacy/demo/
  full-text claims and the hard-coded path are absent from current docs, and
  `git diff --check` passes.
- Plan check: roadmap items such as EMAIL-01, RUN-01, OUTBOX-01, FRESH-01,
  RAG-01, PROFILE-01, PRIV-01, EXPORT-01, and DEP-01 remain visibly TODO; this
  documentation pass does not claim those capabilities or change production
  behavior.
- Independent review: compared every public claim against package scripts,
  source adapters, ingest/refine flow, Web queries/pages/APIs, deployment
  preflight, and launchd installer. No unresolved P0, P1, or P2 documentation
  finding remains.
- Result: DONE.

## ARXIV-01 — fair, validated official arXiv ingestion

- Red evidence: staged regressions reproduced first-label starvation, a
  three-paper cross-list graph where greedy allocation missed a feasible
  AI/CL/LG matching, silent acceptance of malformed XML/wrong roots/schema
  drift, unlabelled Atom revisions, unsupported `atom:` fields, identity
  extraction from an unrelated host or abstract citation, impossible and
  timezone-dependent dates, and an unchecked second combined-feed URL.
- Implementation: one official combined RSS request covers all seven configured
  categories and remains capped at 30. Stable arXiv IDs are accepted only from
  exact identifiers or trusted arXiv URLs, version suffixes are removed from
  identity, `replace*` and unlabelled Atom revisions are excluded, and duplicate
  versions merge category options. A deterministic augmenting matcher allocates
  every cross-list fairly without consuming scarce candidates greedily. RSS,
  default Atom, and `atom:`-prefixed Atom are parsed behind strict XML/root and
  per-entry schema validation; dates require valid calendar values and explicit
  timezones bounded to +/-14:00 before canonical ISO output.
- Targeted verification: ARXIV/config tests pass 28/28, including both request
  URLs, the concrete greedy counterexample, exhaustive three-paper cross-list
  graphs, valid empty feeds, pure and mixed schema drift, RSS/Atom variants,
  replacement/version filtering, trusted identity, and date boundaries. The
  Root suite passes 26 files and 281/281 tests; typecheck, full lint, and
  `git diff --check` pass. `arxiv.ts` coverage is 94.66% statements, 85.71%
  branches, 100% functions, and 97.82% lines.
- Live canary: repeated read-only calls to the exact official combined RSS feed
  returned 30 unique canonical papers with ISO timestamps and deterministic
  category counts of 5/5/4/4/4/4/4; no duplicate/versioned external ID,
  `replace*` entry, non-canonical URL, retry, or fallback was observed.
- Plan check: ARXIV-01 now satisfies combined-feed, category additions, fair
  allocation, replacement filtering, and stable-ID acceptance targets. Actual
  lookback enforcement, cross-source canonical identity, additional scholarly
  sources, and source compliance remain explicitly assigned to FRESH-01,
  ID-01, SRC-01, and COMPLY-01.
- Independent review: the final review exhaustively compared 309,504 allocation
  graphs (two to four categories, one to five candidates, and varying limits)
  with max-min-optimal assignments and found no counterexample. It reran the
  focused/full suites and live feed and reported no remaining P0, P1, or P2.
- Result: DONE.

## 2026-07-15 continuation — reliability, sources, and operations

This entry records new work after the issue-by-issue ledger above. Final counts
below come from the settled branch after the independent cross-module review.

### ALERT-01 — independent delivery-health alert

- Red evidence: a successful ingest process could still leave every configured
  channel pending/failed after the delivery deadline, while a delivery worker
  that failed before claiming database work had no independent notification.
- Implementation: service-only delivery-health/alert RPCs use leases, retry
  state, bounded errors, and one deadline alert per date/key. The 15-minute
  worker checks configured channels after 23:30 and sends a bounded HTTPS
  Webhook; entrypoint failures also attempt the independent Webhook without
  replacing the original exit failure.
- Verification: alert, delivery-health, worker-entry, configuration, database
  permissions, lease and retry tests pass. `doctor`, launchd and cloud runtime
  materialization require `ALERT_WEBHOOK_URL` for unattended operation.
- Remaining gate: no real Webhook credential is configured in the target
  environment, so receipt, provider outage, and duplicate-suppression canaries
  remain blocked rather than being reported as successful.
- Result: GREEN.

### BLOG-01 — bounded first-party research blogs

- Red evidence: dead/nonexistent feeds could silently disappear, sitemap
  entries had no useful summary, and an aggregate where every publisher failed
  looked like a healthy empty source.
- Implementation: the active registry now covers Hugging Face, DeepMind,
  Google Research, OpenAI, Anthropic, BAIR, Apple ML, and Microsoft Research
  using first-party feeds or constrained sitemap adapters. Host/path allowlists,
  strict XML, size/time bounds, HTML stripping and limited page enrichment are
  enforced; publisher failures are isolated and an all-failed aggregate throws.
- Verification: provider fixtures and the public-source dry canary pass. The
  canary returned healthy results from the other active sources while accepting
  a zero-result ACL batch as a legitimate freshness outcome.
- Independent review: the final cross-module pass found no unresolved source
  correctness, compliance, timeout or documentation issue.
- Result: DONE.

### ID-01 / NOVEL-01 — canonical identity and recent-delivery suppression

- Red evidence: title-hash/source-row identity could split one work across
  arXiv/Hugging Face/ACL/DOI URLs, merge unstable titles, and let a URL-form
  change bypass recent-delivery filtering.
- Implementation: normalization derives bounded canonical keys from trusted
  arXiv, DOI, ACL and OpenReview identities before a source-identity hash
  fallback. The database migrates legacy rows, stores source observations,
  routes upserts through canonical uniqueness, and exposes a service-only
  successful-delivery lookup used before ranking.
- Verification: normalization/property, URL, collision, legacy upgrade,
  foreign-key, novelty and concurrent identity tests pass. Independent database
  review found no unresolved identity/migration issue, and the final complete DB
  rerun includes the later delivery-replay and fencing migrations.
- Results: ID-01 DONE; NOVEL-01 DONE.

### UX-01 / EXPORT-01 — truthful private-reader outcomes

- Red evidence: provider/database failures could be rendered as empty/success,
  optimistic mutations could remain visible after failure, and “PDF export”
  wording implied a server-rendered PDF that did not exist.
- Implementation: private routes and client mutations expose real loading,
  empty, degraded and error outcomes with rollback. Authenticated exports remain
  Markdown/Word; PDF is explicitly browser print rather than a generated-file
  claim.
- Verification: route-state, mutation, export-boundary, semantic re-anchoring,
  production build and browser tests pass on the settled branch.
- Results: UX-01 DONE; EXPORT-01 DONE; ANNO-01 DONE.

### DR-01 / CLOUD-01 / PRIV-01 — honest operational boundary

- Implementation: allowlisted state backup/restore excludes secrets and
  database content, uses private modes, verifies hashes/schema/paths and defaults
  to dry-run. The GitHub ingest schedule is default-off and materializes only an
  explicit secret allowlist. Scheduled logs use mode `0077` umask and `0600`
  current/rotated files; feedback bodies are not written to local logs.
- Verification: backup/restore, hostile bundle, CLI parsing, cloud runtime,
  scheduler and privacy regressions pass; the accompanying operations/privacy
  documents state that Supabase backup, retention deletion and RPO/RTO remain
  owner/platform responsibilities.
- Remaining scope: pure-cloud delivery-worker/deadline scheduling, audited data
  deletion/export controls, local-model mode, and real credential canaries are
  still open. These are not hidden by the implemented documentation.
- Results: DR-01 DONE; CLOUD-01 and PRIV-01 remain TODO.

### Activation and publication blockers

- Production Supabase/Web verification needs the target project URL, service
  role, owner/runtime configuration and applied migrations.
- Independent alert and authenticated OpenAlex canaries need their respective
  HTTPS Webhook and official API key.
- Launchd acceptance needs the three jobs installed on the target Mac.
- Publishing workflow-file changes needs the GitHub CLI credential refreshed
  with `workflow` scope. No credential value belongs in this ledger.

## 2026-07-15 final closure — run fencing, retries, and integrated review

- Red evidence: the publish review reproduced two release-blocking gaps. An old
  worker could heartbeat, pause through the six-hour takeover window, then
  resume a plain item upsert without its run UUID. A low-candidate attempt also
  returned success after recording `skipped`, allowing the scheduler to write a
  success marker and suppress the intended interval retry.
- Implementation: `upsert_pipeline_items` validates the exact date/run UUID and
  performs the bounded batch upsert while holding the same date advisory
  transaction lock. The production ingest path always supplies that owner;
  manual no-pipeline callers retain the documented compatibility path. A
  shortage now finalizes its attempt once as `skipped`, raises a typed incomplete
  error, exits nonzero at the entrypoint and therefore never writes the schedule
  success marker. The next interval creates a fresh auditable attempt.
- Verification: focused TypeScript tests cover RPC routing, stale-owner failure,
  one-time skipped finalization and failure-to-success schedule retry. Pipeline
  pgTAP passes 60/60: the old UUID receives `P0001` with zero item side effects,
  while the replacement UUID writes exactly one candidate. Complete clean and
  populated migration paths, permissions, concurrent races and schema lint pass.
- Final application gate: clean Root/Web `npm ci` installs report zero
  vulnerabilities. Root passes 54 files/492 tests at 85.45% statement and
  87.58% line coverage; Web passes 44 files/702 tests at 90.37% statement and
  92.29% line coverage; lint, type checking, production build,
  `git diff --check`, and Chromium E2E 10/10 pass.
- Public source canary: arXiv 30, Hugging Face 7, GitHub 25, official research
  blogs 12 and OpenAlex 20 passed the two-day freshness gate; the ACL batch was
  correctly empty because its entries were stale. Canonical deduplication left
  94 candidates without calling the LLM, database or delivery providers.
- Integrated closure: BLOG-01, ID-01, NOVEL-01, SRC-01, ANNO-01, UX-01,
  EXPORT-01 and DR-01 satisfy their implemented acceptance targets and are
  promoted to DONE. SIMPLIFY-01 removes obsolete source/claim paths and the
  redundant normal-path ledger condition without changing behavior.
- Independent review: the final reviewer traced lock ordering, takeover timing,
  entrypoint exit propagation and marker creation and reported PASS with no
  unresolved P0/P1/P2. The two non-blocking P3 test/wording suggestions were
  added before publication.
- Result: DONE for the requested local code, source audit, reliability and
  onboarding scope. Credential-dependent live activation gates remain explicit
  in `tasks/remediation-plan.md` and are not represented as successful canaries.
