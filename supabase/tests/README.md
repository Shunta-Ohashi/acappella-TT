# Cloud Event database tests

These scripts exercise the real `cloud_events` checks, RLS, RPC permissions,
membership authorization, and the membership-lock ordering used by Cloud Event
deletion. Run them only against a disposable local Supabase/PostgreSQL database.
They create rows in `auth.users` and require an administrator connection.

## Prerequisites

1. Start a disposable Supabase-compatible PostgreSQL database.
2. Apply every file in `supabase/migrations` in filename order.
3. Install `psql`. The concurrency test also needs the server-side `dblink`
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
```

The first script is wrapped in a transaction and rolls back all fixtures. The
concurrency script must commit between two database connections to prove lock
ordering, so it cleans up its fixed-ID fixtures when successful. Use a disposable
database because an interrupted run can leave those fixtures behind.

The concurrency test uses a bounded polling loop only to observe the second
connection waiting on a PostgreSQL lock; ordering is established by the RPC call
and asynchronous membership mutation, not by assuming a fixed sleep duration.

Expected result: both `psql` commands exit with status 0. A skipped command is
not a passing database test.
