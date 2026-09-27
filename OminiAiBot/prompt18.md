# OminiAi Prompt 18 — Fix blank app-open crash + design the backend to survive load

## Goal
Fix the bug that makes the app open to a **blank screen** for every user right now, and put a
proper caching/reliability design in place so the backend and database stay fast and never get
overloaded as usage grows — without ever going back to a fully blank screen on a failed request.

## Problem 1 — App opens blank for everyone (root cause found)
`getMe` in `src/lib/app.functions.ts` now calls a database function that doesn't exist:

```ts
(supabaseAdmin.rpc as any)("user_withdrawn_or_pending", { p_user: user.id })
```

There is **no migration file anywhere in `drizzle/migrations/` that creates
`user_withdrawn_or_pending`** — the function was referenced in application code but never created
in the database. Every app open calls `getMe`, this call fails, and because `src/routes/index.tsx`
(and other screens) do `if (!data || !me) return null;`, the entire screen renders nothing —
no loading spinner, no error message, just blank. That's exactly the symptom being reported.

### What to change
1. Add a real database migration that creates `user_withdrawn_or_pending` as a `security definer`
   SQL function, following the exact same pattern already used for `apply_balance` and
   `credit_deposit` in `drizzle/migrations/0000_ominiai_core_schema.sql` (search-path locked,
   revoked from `public`/`anon`/`authenticated`, granted only to `service_role`):

   ```sql
   create or replace function public.user_withdrawn_or_pending(p_user bigint)
   returns numeric language sql stable set search_path = public as $$
     select coalesce(sum(amount), 0) from withdrawals
     where user_id = p_user and status <> 'rejected';
   $$;

   revoke all on function public.user_withdrawn_or_pending from public, anon, authenticated;
   grant execute on function public.user_withdrawn_or_pending to service_role;
   ```

2. Run/deploy this migration **before or together with** the code that calls it — never ship code
   that depends on a new database object in a separate step from the migration that creates it.
3. Keep the existing JS fallback in `getMe` (the `if (wds.error)` branch) as a genuine safety net,
   not as the primary path — it should only ever trigger if the DB call has a transient problem,
   not because the function is missing.

## Problem 2 — No screen should ever be allowed to render blank
This bug was only *visible* because of the missing function, but the real, structural issue is
that any failed or slow query currently results in a blank screen with zero feedback. That has to
be fixed independently of the specific bug above, so a future failure (network blip, a slow query,
a bad deploy) degrades gracefully instead of looking like "the app is broken."

### What to change
1. In every route that currently does `if (!data || !me) return null;` (`index.tsx` and any other
   screen with the same pattern), replace the blank return with:
   - A lightweight skeleton/placeholder UI while the query is loading (`isLoading`).
   - A visible retry state with an error message and a "Try again" action when the query has
     failed (`isError`), instead of silently rendering nothing.
2. Wrap the app shell in a top-level React error boundary so a render-time exception in one screen
   can't take down the whole app with a blank white/black screen.
3. Where reasonable, let `useMe()` keep serving its last-known cached value (React Query already
   keeps this in `gcTime`) while a background refetch is in flight or retrying, instead of dropping
   back to nothing.

## Problem 3 — System design so the backend/database can absorb real load
This is a Cloudflare Workers + Supabase (Postgres via PostgREST) stack. To keep it fast and stop
the database from becoming the bottleneck as users grow, put these in place:

1. **Collapse the boot round trip.** `bootstrap` and `getMe` are currently two separate round
   trips on every app open. Merge them into a single server function that does the upsert/touch
   logic and returns the home payload in one response, so app open costs one network hop to the
   edge, not two.
2. **Edge-cache the hot read path.** `getMe`'s mostly-read data (settings, referral count, admin
   flag) is a great fit for a short-TTL cache at the edge (Cloudflare KV or the Cache API) keyed by
   user id, with a TTL of a few seconds and **stale-while-revalidate**: serve the cached response
   instantly, refresh it in the background. This turns most app opens into a cache hit instead of a
   database round trip.
3. **Keep and extend the in-memory caches already in the code.** `getSettings()`'s 45s cache and
   `bootstrapUser`'s 10-minute `knownUsers` map are good instincts — keep them, and apply the same
   short-TTL-cache pattern to other read-heavy, rarely-changing lookups (e.g. `isAdmin`).
4. **Use Supabase's pooled connection string (PgBouncer, transaction mode)** for all server-side
   `supabaseAdmin` access from Workers, since each Worker invocation can otherwise open a fresh
   Postgres connection — pooling is what lets the database handle many concurrent edge requests
   without exhausting connections.
5. **Query for aggregates in the database, never in JavaScript.** Any place still doing
   `.select(...)` for many rows and summing/counting in JS (instead of `sum()`/`count` in SQL)
   should be converted the same way `user_withdrawn_or_pending` was meant to — this keeps row
   volume growth from ever slowing down a hot-path request.
6. **Index every column a hot-path query filters or joins on.** Audit `withdrawals`, `deposits`,
   `transactions`, `referrals`, and `wallets` for `(user_id, status)`/`(user_id, created_at)`-style
   composite indexes matching how `getMe`, `bootstrapUser`, and the admin panel actually query them,
   not just the single-column indexes that exist today.
7. **Rate-limit per user at the edge**, not just rely on the frontend's click guards. A lightweight
   Cloudflare KV-based counter that rejects a user's requests to the same server function if they
   already have one in flight (mirroring what `src/lib/busy.ts` does client-side) protects the
   database even from a broken/compromised client, not just an accidental double click.
8. **Add basic observability.** Log slow queries and RPC/database errors (not just catch-and-swallow
   them) with enough context to see a missing function or a missing index in monitoring before it
   ever reaches a user — this is what would have caught problem 1 before shipping it.
9. **Treat schema/migration changes and the code that depends on them as one atomic deploy.**
   Never merge a code change that calls a new database function/column/index unless the migration
   that creates it ships in the same deploy and has been verified against the actual database.

## Verification
- Check code/build diagnostics after changes.
- Confirm `user_withdrawn_or_pending` exists in the database after migration and returns the
  correct total for a test user with a mix of paid/pending/rejected withdrawals.
- Open the app and confirm the home screen renders (not blank) even if a query is artificially
  made to fail, showing the skeleton/error+retry state instead.
- Confirm app open now takes one round trip (or one cache hit) instead of two sequential ones, and
  that repeated opens within the cache TTL don't hit the database again.
- Load-test (or simulate) several app opens for the same user in quick succession and confirm the
  edge rate limit/cache prevents a query storm from reaching Postgres.

- pahle ye karo- ek bar tum command chala ke koi data lo database se, ho sakta hai database me hi problem aa gaya ho.
