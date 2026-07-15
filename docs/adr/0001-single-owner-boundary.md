# ADR 0001: single-owner data boundary

## Decision

Frontier Paper Dispatch remains a single-owner private reading system. The
owner is pre-created and confirmed in Supabase Auth; public signup and
anonymous access stay disabled. Root ingestion uses a server-only service-role
capability, while Web mutations re-check the authenticated owner and request
origin before reaching the database.

## Consequences

- User-facing rows do not carry a tenant column yet; introducing multi-tenancy
  would require a new ownership migration and a complete RLS review.
- Private tables use forced RLS and API roles have no direct CRUD privileges.
- IDOR coverage proves a real non-owner cannot mutate owner business rows; the
  local harness also verifies login/logout isolation and cleanup.
- System rows (run ledger, summaries, snapshots, outbox and budgets) are
  service-only and never exposed to the browser.

This ADR is intentionally explicit so future product work does not infer
multi-tenant guarantees from the current single-owner deployment.
