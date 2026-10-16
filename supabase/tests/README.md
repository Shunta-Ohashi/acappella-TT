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
   - `20261008170000_cloud_event_workspace_generation.sql`
   - `20261012100000_cloud_workspace_master_foundation.sql`
   - `20261012110000_cloud_workspace_master_contracts_v2.sql`
   - `20261013100000_cloud_workspace_master_backfill.sql`
   - `20261013110000_cloud_event_v2_persistence_foundation.sql`
   - `20261014100000_cloud_v2_cutover_inspection.sql`

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
$env:ACAPPELLA_TT_DBLINK_DATABASE_URL = $env:ACAPPELLA_TT_TEST_DATABASE_URL
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL -f supabase/tests/cloud_event_authorized_delete.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_event_authorized_delete_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_event_authorized_page_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_workspace_master_foundation.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_workspace_master_cascade.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_workspace_master_foundation_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_workspace_master_contracts.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_workspace_master_contracts_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_workspace_master_backfill.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_workspace_master_backfill_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_event_v2_persistence.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_event_v2_persistence_concurrency.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -f supabase/tests/cloud_v2_cutover_inspection.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/cloud_v2_cutover_inspection_concurrency.sql
pnpm test:cloud-v2-cutover-cleanup-concurrency -- `
  --db-url-env ACAPPELLA_TT_TEST_DATABASE_URL `
  --confirm-disposable
node scripts/cloudEventMigrationCatalogRegression.mjs `
  --db-url-env ACAPPELLA_TT_TEST_DATABASE_URL `
  --confirm-disposable
```

The deployed Workspace-master Edge adapter has a separate real-HTTP smoke
runner. It creates real local Auth users through the Admin API, signs each user
in to obtain distinct JWTs, calls the running Function route, and verifies the
backend-only RPC boundary. It deliberately refuses database ports 54322 through
55122. Follow the environment and two-terminal instructions in
[`docs/cloud-setup.md`](../../docs/cloud-setup.md#workspace-master-edge-functionの実http-smoke),
then run:

```powershell
npm run test:cloud-workspace-master-http-smoke
```

The runner requires `--confirm-disposable` through the package script, a
loopback Supabase/API/Function/Database URL, `psql`, and a new disposable
database. Its setup and cleanup SQL target only Workspace IDs reserved by the
fixture; Auth cleanup targets only the fixture's exact email addresses. It does
not disable JWT verification and must never receive production keys or tokens.

Snapshot V2 save has its own real-HTTP smoke runner. It is hard-bound to a new
loopback Supabase API on `55721` and PostgreSQL on `55722`; it rejects every
other port and requires `--confirm-disposable`. Follow the two-terminal setup in
[`docs/cloud-setup.md`](../../docs/cloud-setup.md#snapshot-v2保存functionの専用実http-smoke),
serve `save-cloud-event-v2` with JWT verification enabled, then run:

```powershell
npm run test:cloud-event-v2-http-smoke
```

The runner creates exact-email Auth users, applies only the dedicated
`76000000-...-001` through `003` fixture Workspaces, and checks the HTTP result
against the authorized page RPC plus read-only PostgreSQL invariants. A failed
or interrupted run can be cleaned only after rechecking the disposable target:

```powershell
node scripts/cloudEventV2HttpSmoke.mjs --confirm-disposable --cleanup-only
```

Neither command resets a database, disables JWT verification, or deletes users
outside the four exact smoke-test email addresses.

`test_db_url` is opened by the PostgreSQL server through `dblink`, so it may
need a different host from the outer `psql` URL. For the verified Windows +
Docker Desktop inspection environment, the outer URL used `127.0.0.1:55822`.
The dblink URL used the IPv4 address of that same dedicated DB container and
its internal port 5432:

```text
postgresql://postgres:<password>@<container-ip>:5432/postgres?connect_timeout=5&require_auth=scram-sha-256,md5
```

Resolve the container at execution time with `docker ps` filtered by the
dedicated published DB port, verify its name/port mapping, then obtain its
current IPv4 with `docker inspect`. Do not copy a previous run's `172.*`
address. A loopback/container route that does not actually authenticate can
make non-superuser `dblink_connect` fail with `password or GSSAPI delegated
credentials required`; do not work around that with `dblink_connect_u` or
additional role privileges. Do not print or persist the password-bearing URL.
The complete PowerShell checks are in
[`docs/cloud-v2-cutover-preflight.md`](../../docs/cloud-v2-cutover-preflight.md).

The core, Workspace-master foundation, Master contract, and regular cutover
inspection scripts are wrapped in transactions and roll back their fixtures.
Concurrency scripts must commit between database connections to prove lock
ordering, so they clean up fixed-ID fixtures only when successful. The cutover
inspection concurrency fixture refuses to delete a pre-existing fixture at
startup and verifies cascading cleanup at normal completion. If interrupted,
inspect its exact Workspace/name/Event first and run the dedicated cleanup SQL;
that cleanup accepts only the exact event-not-created, Before, or After fixture
state. It compares the full Snapshot JSONB and its matching Event revision and
Workspace generation, and refuses unexpected membership, Master/reference, or
backfill data with SQLSTATE `55000`. Use only a disposable database because an
interrupted concurrency run can leave fixtures behind.

The cleanup concurrency runner launches the actual strict cleanup SQL in
separate `psql` processes. It proves that Event-writer-first and
membership-writer-first races reject cleanup with SQLSTATE `55000` without
deleting committed data. It then pauses actual cleanup after all row locks,
observes both writers waiting through bounded `pg_stat_activity` polling, lets
cleanup commit, and verifies the writers cannot recreate deleted data. It
removes only Workspace `79500000-0000-4000-8000-000000000001` plus Auth user
`00000000-0000-4000-8000-000000000075` and requires all related tables to be
empty. Run it only after the regular inspection concurrency fixture has removed
the shared Workspace ID. Existing fixed Workspace/Auth IDs make setup stop;
they are never auto-deleted at startup. Inspect them before manual recovery.

After that explicit review, clean only the interrupted inspection fixture with:

```powershell
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v ON_ERROR_STOP=1 `
  -f supabase/tests/cloud_v2_cutover_inspection_concurrency_cleanup.sql
```

Do not run the cleanup after a successful concurrency test: success already
removed and checked the fixture, and the cleanup intentionally fails when the
dedicated Workspace is absent.

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

The Page concurrency test also performs an internal Workspace Member mutation
to prove that the new master trigger waits on the same generation-row lock and
invalidates a stale page generation. The Workspace-master foundation test
checks ordered Band members, same-Workspace composite FKs, Event reference
cascade/direct-delete behavior, legacy delete blocking, RLS/direct-ACL denial,
and monotonic generation updates without exposing any production endpoint. The
focused Workspace-master cascade test covers member-only, Band relation,
shared-Member, Event-reference, and legacy/ready/conflict Workspaces. It proves
that a parent Workspace DELETE removes the whole graph in one statement while
the same RESTRICT references still reject direct deletion of referenced Members
and Bands; its fixtures stay inside one transaction and roll back.
The Workspace-master concurrency test deterministically observes both lock
orders between a direct Master DELETE and ready-to-conflict/legacy status
changes. It verifies fail-closed status-first deletion, valid delete-first
serialization, generation changes, bounded timeouts, and parent Workspace
cascading without weakening the production ACL/RLS contract.

The concurrency tests use a bounded polling loop only to observe the second
connection waiting on a PostgreSQL lock; ordering is established by the RPC call
and asynchronous membership mutation, not by assuming a fixed sleep duration.

The Snapshot V2 contract fixture verifies backend-only EXECUTE, ready gating,
owner/editor authorization, viewer/outsider denial, create/update revision CAS,
Workspace generation CAS, exact direct/transitive Master closure, V1-row
overwrite denial, ready-Workspace V1 writer denial, atomic reference-index
replacement, and reference cleanup on Event deletion. Its outer transaction
rolls back every fixture. The V2 concurrency fixture commits across dblink
connections to prove same-Event stale revision rejection and serialization
between a referenced-Member update and Event V2 save. It uses only its reserved
Workspace/Auth IDs and cleans those IDs at startup and successful completion.

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
