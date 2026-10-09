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
- later delete/page/save functions and the `COLLATE "C"` page index;
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

Applying pending migrations is a separate approved operation. Preserve the
existing deployment order: create the save RPC, deploy and verify the save Edge
Function/frontend, then apply the direct-write revoke migration.

## Disposable-database exercise

This is an integration exercise, not proof about a production project. On a
disposable Supabase-compatible database only:

1. Apply `20261007_auth_workspace.sql` and the current base SQL. The current
   base is the same SQL as the known final old file before rename.
2. Mark `20261007` and `20261007120000` applied using official CLI repair with an
   explicit disposable `--db-url`; do not mark the new version.
3. Apply `supabase/tests/cloud_event_migration_history_fixture.sql` to create one
   Event row with known snapshot/revision/timestamps.
4. Run check mode, record row count/digest, run approved apply mode, then run
   check mode again.
5. Require state C and the identical row count/digest. Also query the fixture row
   directly if required by the change record.

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
