# Cloud Event database tests

These scripts exercise the real `cloud_events` checks, table privileges, RLS, RPC permissions,
membership authorization, and the membership-lock ordering used by Cloud Event
reads, saving, and deletion. Run them only against a disposable local
Supabase/PostgreSQL database.
They create rows in `auth.users` and require an administrator connection.

## Prerequisites

1. Start a disposable Supabase-compatible PostgreSQL database.
2. Apply the migrations in version order. The relevant dependency chain in
   this repository is:

   - `20261007_auth_workspace.sql`
   - `20261008110000_cloud_event_persistence.sql`
   - `20261008120000_cloud_event_authorized_delete.sql`
   - `20261008130000_cloud_event_rpc_only_delete.sql`
   - `20261008140000_cloud_event_authorized_page.sql`
   - `20261008150000_cloud_event_authorized_save.sql`
   - `20261008160000_cloud_event_rpc_only_save.sql`

   These names are ordered both by their migration version prefixes and by
   ordinary filename sorting; do not infer that every external migration tool
   uses shell filename order without checking that tool's migration history.
3. Install `psql`. The concurrency tests also need the server-side `dblink`
   extension and permission to inspect `pg_stat_activity`.
4. Set an administrator URL for that disposable database. Do not use a shared,
   staging, or production database.

The application process must still use an anon key plus an authenticated user
session. The administrator URL below is only for fixture setup and assertions;
the scripts switch to the actual `authenticated` and `anon` PostgreSQL roles and
set `request.jwt.claim.sub` before exercising RLS/RPC behavior.

## Run

```powershell
$env:ACAPPELLA_TT_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL -f supabase/tests/cloud_event_authorized_delete.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_TEST_DATABASE_URL" `
  -f supabase/tests/cloud_event_authorized_delete_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_TEST_DATABASE_URL" `
  -f supabase/tests/cloud_event_authorized_page_concurrency.sql
node scripts/cloudEventMigrationCatalogRegression.mjs `
  --db-url-env ACAPPELLA_TT_TEST_DATABASE_URL `
  --confirm-disposable
```

The first script is wrapped in a transaction and rolls back all fixtures. The
concurrency scripts must commit between two database connections to prove lock
ordering, so they clean up their fixed-ID fixtures when successful. Use a disposable
database because an interrupted run can leave those fixtures behind.

The catalog regression command requires the complete migration chain and runs
the repository's real migration-history preflight once for the safe baseline
and once per deliberately damaged catalog. Each mutation is enclosed in a
transaction and rolled back. It covers effective/inherited and PUBLIC table or
column writes (including grant option), every delete/page/save authorization
function's effective EXECUTE contract and SECURITY DEFINER mode, and one-at-a-time
Auth / Workspace column, PK, CHECK, FK, RLS, policy, function, trigger, and
privilege changes. `--confirm-disposable` is mandatory; this is never a
production repair or migration command.

Supabase-managed `service_role`, `anon`, and `authenticated` roles are never
renamed, dropped, or otherwise altered by the real-database fixture. Role absence
is covered by the read-only preflight readiness fields and analyzer/unit
regressions, which verify that a missing required role remains fail-closed.
Supabase protects these reserved roles even in a disposable local environment,
so mutating them is not a portable catalog-regression scenario.

The RPC-only DELETE and save migrations perform the same fail-closed check
after revoking direct browser grants. If `anon` or `authenticated` still has an
effective DELETE or INSERT/UPDATE privilege through a custom role, migration
application must fail. The authorized-save migration also verifies its
backend-only RPC immediately after creation, and the RPC-only save migration
rechecks it: SECURITY DEFINER and effective service-role EXECUTE are required,
while PUBLIC and effective anon/authenticated EXECUTE are forbidden. Catalog
regressions cover inherited EXECUTE through custom roles for both browser roles.
Repair inherited GRANTs, role memberships/custom roles, or unsafe function
default privileges explicitly and rerun; do not grant browser access merely to
make a fixture pass.

The concurrency tests use a bounded polling loop only to observe the second
connection waiting on a PostgreSQL lock; ordering is established by the RPC call
and asynchronous membership mutation, not by assuming a fixed sleep duration.

Expected result: all `psql` commands exit with status 0. A skipped command is
not a passing database test.

The core script verifies that `authenticated` retains direct `SELECT`, while
direct `INSERT`/`UPDATE`/`DELETE` and direct execution of the internal save RPC
are revoked. Backend save is exercised through the service-role-only RPC, which
locks and rechecks the supplied actor's owner/editor membership before upsert;
its SQL fixture is a complete app-loadable empty Event snapshot. Owner/editor
deletion is exercised only through
`delete_cloud_event_authorized`, including its idempotent `already_absent`
result. It also exercises authorized owner/editor/viewer page reads, denied
non-member/anonymous/cross-Workspace reads, empty-page envelopes, and the
database-owned `COLLATE "C"` keyset order. Applying every migration in order
also covers the upgrade-safe write revokes that follow the original table grant.

## Renamed migration and existing histories

`20261008110000_cloud_event_persistence.sql` was previously named
`20261007120000_cloud_event_persistence.sql` while this feature was under
development. If an environment already recorded the old version, do not apply
the renamed base migration or blindly repair its history: first compare
`supabase_migrations.schema_migrations` with the actual `cloud_events` table,
triggers, policies, and constraints. After taking the environment's normal
backup, an operator may reconcile only the migration-history entry using the
approved Supabase migration-repair procedure. This repository does not perform
that operation automatically. Fresh databases and environments where the old
file was never applied use the new name normally.

The executable read-only preflight, state-specific official CLI commands,
interruption recovery, and disposable-database fixture are documented in
[`docs/cloud-event-migration-history-repair.md`](../../docs/cloud-event-migration-history-repair.md).
Run that procedure before normal migration application; the default helper mode
only inspects and plans, while history mutation requires explicit `--apply` and
target-fingerprint confirmation.
