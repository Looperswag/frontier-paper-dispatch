# Frontier Paper Dispatch remediation plan

This file is the authoritative completion ledger for the reliability rebuild.
An item is complete only after all five gates are recorded in `tasks/reviews.md`:

1. a regression test fails for the intended reason;
2. the smallest production fix passes the targeted test;
3. adjacent tests, type checking, linting, and `git diff --check` pass;
4. the change is checked against this plan and does not expand or narrow scope;
5. an independent code review finds no unresolved correctness, security, privacy, cost, or documentation issue.

Status values: `TODO`, `RED`, `GREEN`, `REVIEWED`, `DONE`.

## 2026-07-15 execution snapshot

The `frontier-paper-dispatch` checkout is the canonical repository; the legacy
`paper-station` checkout and job are gone. Implementation and fixture/
local-database verification can continue without production credentials, but
the following activation gates are external rather than code defects:

| Gate | Current state | Required closure |
|---|---|---|
| Production Supabase and Web | BLOCKED | Configure Root `SUPABASE_URL`/service-role plus matching Web owner/runtime secrets, apply every migration, and run the live owner/IDOR checks. |
| Independent alert | BLOCKED | Configure an HTTPS `ALERT_WEBHOOK_URL` and prove one receipt without relying on ServerChan or SMTP. |
| OpenAlex authenticated canary | BLOCKED | Add the official free `OPENALEX_API_KEY`; anonymous compatibility remains best-effort. |
| macOS automation | BLOCKED | Complete `npm run doctor`, install the three LaunchAgents, and prove catch-up plus 22:00/23:00/15-minute behavior on the target Mac. |
| GitHub publication | BLOCKED | Refresh the GitHub CLI credential with `workflow` scope, then push this branch and its workflow changes. |

Public-source dry canaries and local deterministic tests are not blocked by
these credentials. Roadmap rows that remain `TODO` below are intentionally not
reclassified as credential blockers.

## Baseline

| ID | Pri | Status | Deliverable |
|---|---:|---|---|
| BASE-01 | P0 | DONE | Remove the local `paper-station` repository and LaunchAgent while preserving personal files; migrate private config/profile and keep Frontier as the only repository. |
| BASE-02 | P0 | DONE | Root unit/integration coverage runner, Web Vitest/Testing Library, Playwright E2E, linting, reproducible scripts, and CI. |
| BASE-03 | P0 | DONE | Production-like test fixtures, deterministic clocks/randomness, fake providers, fault injection, and local Supabase migration/RLS tests. |

## P0 — configuration, security, persistence, and reliable delivery

| ID | Status | Atomic issue / acceptance target |
|---|---|---|
| CFG-01 | DONE | Typed root/Web config, legacy-key migration, one `preflight` command, safe errors, `.env` mode 0600, and production fail-closed checks. |
| DB-01 | DONE | Repeatable Supabase migration workflow; README installs every migration; empty and legacy upgrades are idempotent. |
| AUTH-01 | DONE | Supabase Auth single-user email allowlist; anonymous/non-owner denied in every page and API; production cannot run without auth config. |
| DB-02 | DONE | RLS and explicit grants for all exposed tables; service-role/admin clients remain server-only; ownership permission matrix passes. |
| DB-03 | DONE | Every Supabase result is checked; distinguish an empty result from a failed query; UI never reports false success. |
| API-01 | DONE | Shared authentication/authorization, Zod input schemas, Origin/CSRF checks, consistent error envelopes, UUID/size/depth validation. |
| API-02 | DONE | Distributed per-user/IP rate limits and daily LLM budget with `429`/`Retry-After`; IDOR tests for every mutation. |
| MD-01 | DONE | Sanitized Markdown removes executable markup/schemes while safe external links retain `target=_blank` and `rel=noopener noreferrer`. |
| FB-01 | DONE | Feedback links become GET confirmation + one-time POST; signed token includes digest, expiry, nonce, constant-time verification, and replay protection. |
| HTTP-01 | DONE | Shared HTTP/provider client: explicit timeout/abort, retry only 408/429/5xx/network, Retry-After, exponential jitter, content-type/schema/size validation. |
| LLM-01 | DONE | Explicit LLM timeout/retry/deadline; Zod semantic validation; unique bounded Top-N; prompt-injection-resistant data boundaries. |
| LLM-02 | DONE | Per-item summary isolation, deterministic fallback, cache/version hashes, and degraded-state metadata; one item cannot abort a run. |
| RUN-01 | DONE | Lock `Asia/Shanghai` run date once; durable attempt history and UUID fencing cover item/digest/delivery writes; low-candidate attempts close as skipped but exit retryably without a scheduler success marker. |
| DB-04a | DONE | Service-role-only atomic summary/digest persistence and snapshot-consistent latest-bundle reads; exact current-date reruns are no-op, stale dates/conflicts fail without delivery or writes, failures roll back both relations, and direct DML/bypass RPCs are denied. |
| DB-04b | DONE | FK-backed `digest_items` history with bounded content constraints, idempotent migration/seed backfill, and atomic bundle-trigger capture. |
| OUTBOX-01 | DONE | Transactional delivery outbox with leases, attempts, next retry, provider id, idempotency key, crash recovery, and safe replay. |
| EMAIL-01 | DONE | 163 SMTP TLS email provider with multipart text/HTML, timeouts, classified retries, secret redaction, and Message-ID tracking. |
| WX-01 | DONE | ServerChan provider uses the same reliable delivery layer; validates HTTP/business response, limits, timeouts, retries, and two key formats. |
| ALERT-01 | GREEN | Independent Webhook delivery, leased 23:30 no-success checks, worker-start failure alerts, retry state, and safe payloads are implemented and tested; live receipt is credential-blocked. |
| SCHED-01 | DONE | Doctor and idempotent launchd installer use absolute Node paths, non-TCC checks, single-instance locks, bounded log rotation, and plist linting. |

## P0 — source quality and identity

| ID | Status | Atomic issue / acceptance target |
|---|---|---|
| TIME-01 | DONE | All run and feedback dates use `Asia/Shanghai`; manual morning and cross-midnight runs keep the correct immutable date. |
| ARXIV-01 | DONE | Fair multi-category arXiv allocation/combined feed, `replace*` filtering, category additions, stable IDs, and no category starvation. |
| FRESH-01 | DONE | ISO timestamps and actual lookback enforcement for arXiv/HF/blog; missing/invalid dates are explicit, not silently fresh. |
| BLOG-01 | DONE | First-party feed/sitemap adapters, strict host/path checks, HTML stripping, bounded page enrichment, publisher isolation, all-failed detection, fixtures, and a public dry canary pass. |
| GH-01 | DONE | GitHub collection splits new/active searches, enriches recent repositories with latest releases, and ranks by velocity/recency before total stars. |
| ID-01 | DONE | Canonical arXiv/DOI/OpenReview/ACL identity, URL normalization, bounded source fallback, provenance observations, migration parity, collision/concurrency tests, and independent DB review pass. |
| NOVEL-01 | DONE | Successful-delivery canonical lookup excludes recent delivered works while preserving source/metric observations; cross-module and database reviews pass. |
| SRC-01 | DONE | ACL Anthology and OpenAlex are active behind health contracts; OpenReview, Semantic Scholar and Crossref remain intentionally inactive until their documented bounded contracts are met. |

## P1 — ranking, content, product truthfulness

| ID | Status | Atomic issue / acceptance target |
|---|---|---|
| RANK-01 | DONE | Two-stage bounded deterministic recall plus LLM rerank uses recency, authority/source weight, engagement and velocity signals with stable explanations. |
| RANK-02 | DONE | Greedy MMR-like source/topic caps and deterministic tie breaks are enforced; offline Precision@5/NDCG regression fixture is covered. |
| TEXT-01 | TODO | Fetch and version real paper/blog/GitHub content; sanitize and retain provenance/page/section anchors with bounded storage. |
| RAG-01 | TODO | Chunking, embeddings, hybrid FTS/vector retrieval, citations, and cross-language search; no substring-only/full-context claims. |
| ANNO-01 | DONE | Bounded quote/context/content-version anchors, normalized geometry, legacy compatibility, deterministic re-anchoring, ambiguous-match rejection, and stale-anchor UI states are implemented and tested. |
| PROFILE-01 | TODO | Feedback event history and updated timestamps; explain/approve/rollback profile versions; scheduled behavior matches documentation. |
| UX-01 | DONE | Private routes distinguish loading/empty/error/degraded states and optimistic feedback/chat/annotation failures roll back visibly; integrated Web review and E2E pass. |
| DOC-01 | DONE | README/SPEC/plan accurately describe the implementation status and boundaries of email, auth, full text, RAG, search, profile automation, migrations, privacy, and deployment. |

## P2 — operations, privacy, and maintainability

| ID | Status | Atomic issue / acceptance target |
|---|---|---|
| OBS-01 | TODO | Structured run/source/LLM/delivery logs, correlation IDs, health/status page, freshness/cost/last-success indicators, and retention. |
| COST-01 | TODO | Usage/latency/cost accounting, prompt/model/profile/content versions, caching, daily budgets, and bounded candidate/context sizes. |
| PRIV-01 | TODO | Third-party disclosure, retention boundaries, secret isolation, feedback-log redaction, and mode-0600 scheduled logs are documented/implemented; audited export/delete controls and optional local-model mode remain. |
| DEP-01 | DONE | Supported Node range is declared in both packages and `.nvmrc`; npm lockfiles are authoritative, audits are clean, Dependabot is enabled, and install/build steps are documented. |
| SOCIAL-01 | DONE | Removed the unimplemented X/Facebook stubs and weights; only configured, health-tracked sources enter the ingest pipeline. |
| EXPORT-01 | DONE | Authenticated Markdown/Word export exists, PDF is labelled honestly as browser print, and sanitization/render boundaries pass review. |
| DR-01 | DONE | Allowlisted mode-0600 config/profile backup, hash-verified dry-run/apply restore, hostile-bundle tests, Supabase separation, and honest RPO/RTO documentation pass review. |
| CLOUD-01 | TODO | A default-off GitHub daily ingest workflow and local catch-up/DB lease exist; pure-cloud delivery-worker/deadline scheduling and missed-run acceptance remain. |
| A11Y-01 | TODO | Keyboard, labels, focus, mobile layout, offline/slow/error behavior, and axe checks meet critical WCAG expectations. |
| TENANCY-01 | DONE | Single-owner boundary ADR records owner/system data separation and the real non-owner IDOR/RLS verification limits. |
| COMPLY-01 | DONE | Active source registry records official URL, robots/rate/license/retention metadata; Google Scholar is explicitly not scraped. |
| PERF-01 | TODO | 10k-item query/load benchmarks, EXPLAIN evidence, pagination/body limits, connection/request budgets, and documented SLOs. |
| SIMPLIFY-01 | DONE | Touched code and onboarding were simplified after functional completion; obsolete source stubs/claims and a redundant pipeline-state branch were removed without behavior drift. |

## Final completion gate

- [ ] All rows above are `DONE` and have review evidence.
- [ ] Root and Web clean installs succeed from lockfiles.
- [ ] Lint, typecheck, unit, integration, contract, migration/RLS, fault-injection, build, E2E, dependency audit, and `git diff --check` pass.
- [ ] Line/function/statement coverage is at least 80%; critical auth, RLS, outbox, and run-state branches are fully exercised.
- [ ] Opt-in live canaries validate public sources, Supabase, SMTP receipt, ServerChan receipt, launchd kickstart, and failure alert without duplicate delivery.
- [ ] A final cross-module code review and requirement-by-requirement audit find no unresolved item.
