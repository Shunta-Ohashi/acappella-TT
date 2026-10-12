# Cloud Event base migration rename: history repair runbook

This runbook is only for a database that may already have recorded the former
Cloud Event base version `20261007120000`. The repository keeps the renamed
`20261008110000_cloud_event_persistence.sql` so a fresh database applies Auth /
Workspace first. History repair must happen before any normal `db push`.

Supabase documents that `migration list` compares local versions with
`supabase_migrations.schema_migrations`, while `migration repair` only inserts or
deletes history rows; it does not run or roll back migration SQL:

- <https://supabase.com/docs/reference/cli/supabase-migration-list>
- <https://supabase.com/docs/guides/deployment/database-migrations#step-3-if-the-migration-history-table-is-wrong>

## Preconditions

1. Stop migration/deployment automation for the target project.
2. Identify the exact database and obtain administrator approval. Do not rely on
   whichever project happens to be linked locally.
3. Confirm a current backup and its restore procedure. Do not use `db reset`,
   `DROP`, or data deletion for this rename.
4. Install the already-approved versions of `psql` and Supabase CLI and record
   `supabase --version` in the change record.
5. Put the percent-encoded connection URL in a temporary environment variable.
   Do not place the URL/password in Git, command transcripts, or screenshots.

```powershell
$env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL = Read-Host 'Target database URL'
```

The helper requires `--db-url-env`; omitting the target fails closed. It always
passes `--db-url` to both official CLI commands and never falls back to a linked
project.

## Read-only inspection and plan

The default mode changes nothing. It runs `supabase migration list --db-url ...`
and the read-only catalog query
`supabase/tests/cloud_event_migration_history_preflight.sql`.

```powershell
node scripts/cloudEventMigrationRepair.mjs `
  --db-url-env ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
```

The output contains a `targetFingerprint` derived from the non-secret URL target
(host/port/database) plus the inspected database identity,
detected state, planned history operations, mismatches, and the Cloud Event row
count/digest. The URL itself is not printed. Independently review the catalog
output when needed:

```powershell
supabase migration list --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
psql --no-psqlrc --quiet --no-align --tuples-only `
  --set ON_ERROR_STOP=1 `
  --dbname $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL `
  --file supabase/tests/cloud_event_migration_history_preflight.sql
```

The catalog check covers:

- the Auth reference plus the repository-owned Profile, Workspace, and
  Workspace-membership columns/defaults, PK/FK/CHECK constraints, update
  function/triggers, index, RLS policies, and effective table/column grants;
- migration-history table and old/new/later versions;
- migration history contains only the repository versions understood by this
  one-time helper, contains no duplicate versions, and records later Cloud
  Event migrations as a legal version-order prefix;
- all `cloud_events` columns, primary/foreign/check constraints, including the
  strict Persistence V5 / snapshot V1 shape check;
- metadata functions and triggers, indexes, RLS, policies, and effective client
  write privileges, including inherited anon privileges, PUBLIC ACLs, every
  live user column, and grant option;
- later delete/page/save functions, the `COLLATE "C"` page index, and the
  Workspace generation table/functions/triggers used to reject mixed-version
  pagination;
- each authorization RPC's SECURITY DEFINER mode and effective EXECUTE
  contract (authenticated only for delete/page, service role only for save,
  with no access for the other client/backend roles or PUBLIC);
- complete row count and a deterministic digest including snapshot, revision,
  and timestamps.

The final old migration immediately before rename is byte-identical to the new
base file. Earlier development revisions had a weaker snapshot CHECK. Therefore
the old history entry alone is not sufficient: a failed strict CHECK or any
other catalog mismatch is an unknown state and must not be repaired.

## State decision table

| State | History and catalog | Action |
| --- | --- | --- |
| A — fresh | Neither base version; no Cloud Event schema | No repair. Use the normal new-build path. |
| B — old only | Old version only; catalog matches the known final old schema and all recorded later migrations | After approval, mark new applied, re-inspect, then mark old reverted. Do not execute the base SQL again. |
| C — new only | New version only; catalog matches | Already migrated. No history write. |
| D — both | Both versions; catalog matches | Treat as an interrupted repair. Review the change record and use the explicit resume command to remove only the old history row. |
| E — unknown | Table/history missing on only one side, unknown or duplicate history version, non-prefix later history, weaker/unknown CHECK, missing object, unexpected privilege, or other mismatch | Stop with non-zero status. Investigate or restore; do not hide the difference with history repair. |

## Approved apply and interrupted-resume paths

Copy the fingerprint from a just-completed check and have the administrator
confirm it before applying:

```powershell
node scripts/cloudEventMigrationRepair.mjs `
  --db-url-env ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL `
  --apply `
  --confirm-target '<TARGET_FINGERPRINT>'
```

For state B the helper runs these official operations in this order:

```powershell
supabase migration repair 20261008110000 --status applied `
  --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
supabase migration repair 20261007120000 --status reverted `
  --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
```

These are two separate operations, not one transaction. Immediately before and
after each command, the helper reruns migration-list and catalog inspection. A
command runs only when target identity, the full applied-version set, schema,
row count/digest, and the next legal repair command still match the previously
verified state. It stops immediately on a non-zero exit or any mismatch and does
not run `db push`.

If interruption occurs after the new version is marked applied, rerun check
mode. State D requires an explicit resume; never blindly repeat both commands:

```powershell
node scripts/cloudEventMigrationRepair.mjs `
  --db-url-env ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL `
  --apply --resume `
  --confirm-target '<NEW_CHECK_TARGET_FINGERPRINT>'
```

This removes only the old history entry after revalidating the target, schema,
later-migration state, and data digest. If the second repair previously failed,
this is also the recovery path. If the first repair failed, rerun check mode and
follow the newly reported state instead of assuming nothing changed.

## Completion checks

Run check mode again and require state C (`new-only`). Then use the same explicit
target for a dry-run only:

```powershell
supabase migration list --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
supabase db push --dry-run --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
```

Confirm that:

- `20261008110000` is remote-applied and `20261007120000` is absent;
- dry-run does not try to create `cloud_events` again and lists only genuinely
  pending later migrations;
- row count and digest are unchanged, proving Event snapshot, revision, and
  timestamps were not touched;
- constraints, functions, triggers, indexes, RLS, policies, and privileges are
  unchanged.

Applying pending migrations is a separate approved operation. For an existing
environment, preserve both staged rollout boundaries:

1. Apply `20261008120000_cloud_event_authorized_delete.sql` while direct DELETE
   remains available, deploy and verify the RPC-capable frontend, then drain all
   legacy clients (including already-open tabs, using a maintenance window or
   required reload when needed). Only after no legacy client remains, apply
   `20261008130000_cloud_event_rpc_only_delete.sql` and verify RPC deletion again.
2. Create the save RPC, deploy and verify the save Edge Function/frontend,
   drain legacy clients, then apply the direct INSERT/UPDATE revoke migration
   and verify Edge Function saving again.

Do not apply either revoke while its legacy clients may still be active. A
fresh environment instead applies the complete migration chain before exposing
the current Function/frontend to users; it does not use this upgrade sequence.
Both revoke migrations perform their direct REVOKEs and privilege guards in one
explicit transaction. If `anon` or `authenticated` retains effective DELETE or
INSERT/UPDATE privileges through an inherited custom role, the guard fails and
the direct REVOKEs roll back with the rest of that migration. Treat that as an
unfinished cutover: do not apply the next migration or expose the new release,
inspect and remove the inherited privilege source, and rerun the same migration.
The authorized-save migration additionally verifies
the backend-only save RPC as soon as it is created, and the RPC-only save
migration verifies it again before the final cutover: the function must remain
`SECURITY DEFINER`, only `service_role` may have effective EXECUTE, and PUBLIC,
`anon`, and `authenticated` must not. Inspect and remove inherited EXECUTE/write
GRANTs, unsafe role memberships or custom roles, and unsafe function default
privileges, then rerun the migration; migrations do not alter shared custom
roles automatically.

All eight repository migrations have one explicit `BEGIN` / `COMMIT` boundary.
A failure rolls back the DDL, DML, and ACL changes made by that migration. The
Supabase CLI migration-history write is a separate runner responsibility, so a
failed run must still be checked in both the PostgreSQL catalog and
`supabase_migrations.schema_migrations` before it is retried.

Already-recorded migration versions are not rerun when these files change. Do
not manually rerun a successfully applied migration on an existing environment.
The rollback exercises below require a brand-new disposable database and must
never target the retained browser-test databases on ports `54322`, `54422`, or
`54522`.

### Full migration transaction rollback exercise

Run this only against a newly created disposable database, using a separate
validation worktree. Never edit a migration and then point the CLI at an
existing environment. For each target migration, stage a fresh database at the
immediately preceding version, keep a byte-for-byte backup of the target SQL,
and insert `select 1 / 0;` immediately before its final `COMMIT`. Apply the real
migration through Supabase CLI and require a non-zero exit code. In a `finally`
block, restore the original migration file before any retry.

After the intentional failure, verify that both a target-specific catalog
sentinel and the migration-history row are absent. Suggested sentinels are:

- `20261007`: `to_regclass('public.profiles') is null`
- `20261008110000`: `to_regclass('public.cloud_events') is null`
- `20261008120000`: `to_regprocedure('public.delete_cloud_event_authorized(uuid,text)') is null`
- `20261008140000`: both
  `to_regclass('public.cloud_events_workspace_event_id_c_idx') is null` and
  `to_regprocedure('public.load_cloud_events_page_authorized(uuid,text,integer)') is null`

Use the target version in the following history check and require `false`:

```sql
select exists (
  select 1
  from supabase_migrations.schema_migrations
  where version = 'TARGET_VERSION'
) as failed_migration_recorded;
```

Restore the unmodified file, rerun `supabase db push`, and require both the
catalog sentinel and history row to be present. Use a new disposable database
or restage from scratch for each target; do not reuse a database whose intended
failure or repair state is uncertain. This exercise deliberately distinguishes
PostgreSQL transaction rollback from the CLI's separate history bookkeeping.
The RPC-only cutover exercise below is stronger for `...130000` and `...160000`:
it uses the production privilege guards rather than a synthetic error.

### RPC-only cutover rollback exercise

Run this only in a separate validation worktree and a newly created disposable
database. Set a dedicated URL, and fail before any command if it points at either
retained local environment:

```powershell
$cutoverDbUrl = $env:ACAPPELLA_TT_CUTOVER_ROLLBACK_DB_URL
if ([string]::IsNullOrWhiteSpace($cutoverDbUrl)) {
  throw 'Set ACAPPELLA_TT_CUTOVER_ROLLBACK_DB_URL to a new disposable database.'
}
if ($cutoverDbUrl -match '(127\.0\.0\.1|localhost):(54322|54422|54522)(/|$)') {
  throw 'Refusing to use the retained dbtest, freshcheck, or cutovercheck database.'
}
```

For the Delete case, apply migrations only through `...120000`, record the
current direct DELETE ACL, then create a test-only custom role, grant it DELETE,
and grant that role to `authenticated`. Apply `...130000` through Supabase CLI.
The actual `$cloud_event_delete_privilege_guard$` must fail with SQLSTATE
`42501`. Verify that the direct ACL is byte-for-byte unchanged and that
`20261008130000` is absent from `supabase_migrations.schema_migrations`:

```sql
select relacl from pg_catalog.pg_class
where oid = 'public.cloud_events'::regclass;

select exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20261008130000'
) as delete_cutover_recorded;
```

Use a unique role in that disposable database only:

```sql
create role cloud_event_delete_guard_probe nologin;
grant delete on table public.cloud_events
  to cloud_event_delete_guard_probe;
grant cloud_event_delete_guard_probe to authenticated;
```

Run the real migration through the CLI and require failure rather than allowing
PowerShell to continue silently:

```powershell
supabase db push --db-url $cutoverDbUrl
if ($LASTEXITCODE -eq 0) {
  throw 'Expected the inherited DELETE privilege guard to reject the cutover.'
}
```

Remove only the test role membership and its test grants, then rerun the same
migration and require success. Do not continue to `...140000` after the expected
failure.

For the Save case, use another new disposable database and apply migrations only
through `...150000`. Record both the table ACL and every explicit column ACL:

```sql
select relacl from pg_catalog.pg_class
where oid = 'public.cloud_events'::regclass;

select attname, attacl
from pg_catalog.pg_attribute
where attrelid = 'public.cloud_events'::regclass
  and attnum > 0 and not attisdropped
order by attnum;
```

Create a test-only custom role with inherited INSERT/UPDATE or inherited EXECUTE
on `save_cloud_event_validated`, grant that role to a browser role, and apply
`...160000` through Supabase CLI. The real write or EXECUTE guard must fail with
SQLSTATE `42501`. Require identical table/column ACL query results and confirm
that version `20261008160000` is absent from migration history. Remove only the
test role membership and grants, rerun `...160000`, and require success before
applying `...170000`. Never manufacture the failure with an unrelated `1 / 0`;
the purpose is to exercise the production privilege guards and transaction
rollback together.

```sql
select exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20261008160000'
) as save_cutover_recorded;
```

For an inherited table-write failure, the disposable-only setup is:

```sql
create role cloud_event_save_guard_probe nologin;
grant insert, update on table public.cloud_events
  to cloud_event_save_guard_probe;
grant cloud_event_save_guard_probe to authenticated;
```

Use the same `supabase db push --db-url $cutoverDbUrl` failure check shown for
Delete. To exercise the EXECUTE guard separately, use another freshly staged
disposable database, omit the table grant, and grant only:

```sql
grant execute on function
  public.save_cloud_event_validated(uuid, uuid, jsonb)
  to cloud_event_save_guard_probe;
```

After each expected failure, revoke the probe role from `authenticated`, revoke
its object grants, and drop only that probe role. Recheck ACLs and migration
history before retrying. Never perform this setup against a shared role or a
retained database.

## Disposable-database exercise

This is an integration exercise, not proof about a production project. On a
disposable Supabase-compatible database only. Supabase CLI 2.120.0 was observed
to require a matching local migration filename when marking an otherwise absent
version as applied. This temporary file is needed only to manufacture an
`old-only` history for the exercise; future CLI versions may behave differently.

1. In a disposable validation worktree, reset or apply migrations through
   `20261008110000_cloud_event_persistence.sql`. This creates the current base
   schema and initially records the current version as applied. The current base
   SQL is the same as the known final old file before rename.
2. Before marking the old version applied, create an old-filename copy in that
   validation worktree only. Refuse to overwrite an existing path, and delete
   the copy immediately after the CLI command even if the command fails:

   ```powershell
   $currentBase = '.\supabase\migrations\20261008110000_cloud_event_persistence.sql'
   $temporaryOldBase = '.\supabase\migrations\20261007120000_cloud_event_persistence.sql'

   if (Test-Path -LiteralPath $temporaryOldBase) {
     throw "Temporary old migration already exists: $temporaryOldBase"
   }

   Copy-Item -LiteralPath $currentBase -Destination $temporaryOldBase
   try {
     supabase migration repair 20261007120000 --status applied `
       --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
     if ($LASTEXITCODE -ne 0) {
       throw 'Failed to mark the disposable old migration version applied.'
     }
   }
   finally {
     Remove-Item -LiteralPath $temporaryOldBase -Force
   }

   if (Test-Path -LiteralPath $temporaryOldBase) {
     throw "Temporary old migration was not removed: $temporaryOldBase"
   }
   ```

3. With the temporary file already removed, mark the current version reverted
   and confirm that migration history is now `old-only`:

   ```powershell
   supabase migration repair 20261008110000 --status reverted `
     --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
   if ($LASTEXITCODE -ne 0) {
     throw 'Failed to mark the disposable current migration version reverted.'
   }

   supabase migration list `
     --db-url $env:ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL
   git status --short -- `
     supabase/migrations/20261007120000_cloud_event_persistence.sql
   ```

   The final command must not report the temporary old migration. Files such as
   an untracked `supabase/config.toml` created by `supabase init` are separate
   validation-worktree artifacts; review them independently, but never mistake
   them for permission to retain the old migration file.
4. Apply `supabase/tests/cloud_event_migration_history_fixture.sql` to create one
   Event row with known snapshot/revision/timestamps.
5. Run helper check mode and require `state: old-only` with no mismatches. Record
   the row count/digest, run approved apply mode, and require this plan order:
   `20261008110000` applied, then `20261007120000` reverted.
6. Run check mode again and require `state: new-only`, an empty
   `repairCommands` list, and the identical row count/digest. Query the fixture
   directly and confirm its Event row and revision `1` remain unchanged.
7. Run the completion `supabase db push --dry-run` command. It must not propose
   the base migration again; for a database stopped at the base migration, only
   these later migrations should remain pending:

   - `20261008120000_cloud_event_authorized_delete.sql`
   - `20261008130000_cloud_event_rpc_only_delete.sql`
   - `20261008140000_cloud_event_authorized_page.sql`
   - `20261008150000_cloud_event_authorized_save.sql`
   - `20261008160000_cloud_event_rpc_only_save.sql`
   - `20261008170000_cloud_event_workspace_generation.sql`

The temporary old migration is exclusively an artificial disposable-exercise
fixture. Never create it during production or staging repair, never commit or
push it, and do not permanently restore the renamed migration to this
repository. The `finally` cleanup and the scoped `git status --short` check are
mandatory before considering the exercise complete.

Mock tests cover the state machine and interruption behavior. This disposable
exercise is the real CLI/PostgreSQL check and is not considered passed unless
all commands actually ran successfully.

To exercise the actual PostgreSQL catalogs against the fully migrated
disposable database, also run:

```powershell
node scripts/cloudEventMigrationCatalogRegression.mjs `
  --db-url-env ACAPPELLA_TT_MIGRATION_REPAIR_DB_URL `
  --confirm-disposable
```

The runner invokes the same preflight used by the repair helper. Its SQL fixture
temporarily damages one catalog property at a time inside a transaction and
rolls it back. A missing/loosened policy, constraint, role, RLS flag, trigger,
function, or unsafe table/column grant must therefore be observed as unsafe by
the real catalog query. Merely having the expected check names in a SQL file is
not counted as a passing database test.
