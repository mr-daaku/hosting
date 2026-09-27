# OminiAi Prompt 17 — Speed up app open, fix false "Already reviewed" error, stop double-click spam

## Goal
Reduce app open time and database load, fix the withdrawal review buttons in the admin panel that
falsely show **"Already reviewed"** even when a withdrawal was never actually paid, and add a
disabled/wait-cursor state to every action button app-wide so users/admins can't repeat-click and
flood the backend and database.

## Problem 1 — App open is slow
Root cause: on every app open, three network calls run **one after another** instead of in
parallel/cached, and `react-query`'s defaults make every page navigation and every tab/window
focus in Telegram re-fetch from the server:
- `TgProvider` in `src/lib/tg.tsx` waits for the FingerprintJS load, **then** calls `bootstrap`,
  and only after that resolves does `useMe()` start fetching `getMe`. This is a waterfall, not
  parallel.
- The `QueryClient` in `src/router.tsx` is created with **no default `staleTime`/`gcTime`**, so
  React Query's defaults (`staleTime: 0`, `refetchOnWindowFocus: true`, `refetchOnMount: true`)
  apply everywhere. Telegram Mini Apps fire window-focus events very often (opening the keyboard,
  switching apps, Telegram's own overlays), so this alone causes a lot of avoidable refetching.
- `useMe()` also polls `getMe` every 30 seconds on **every** screen for as long as the app is open.
- `getMe` (in `src/lib/app.functions.ts`) runs 5 queries every single time it's called, and one of
  them (`withdrawals` amounts for `withdrawnOrPending`) selects **every matching row** and sums
  them in JavaScript instead of asking the database for a sum/aggregate. As withdrawal history
  grows per user this query gets slower and heavier over time.

### What to change
1. Start `bootstrap` and the fingerprint lookup in parallel (don't block `bootstrap` on the
   fingerprint), and let `useMe()`'s first fetch fire as soon as `initData` is known instead of
   waiting for `bootstrap` to fully resolve first, where safe to do so.
2. Set sensible defaults on the `QueryClient` in `src/router.tsx`:
   - `staleTime` of at least 15–20 seconds for general queries so navigating between screens
     doesn't always trigger a fresh fetch.
   - `refetchOnWindowFocus: false` (or a longer built-in throttle) since Telegram's frequent focus
     events are not a reliable "the data changed" signal here.
   - Keep `useMe()`'s 30s poll only on the screens that actually need live balance updates, not
     mounted globally if it currently is.
3. In `getMe`, replace the `withdrawals` full-row select + JS `.reduce()` with a database-side
   aggregate (e.g. a Postgres `sum()` via an RPC/view, or Supabase's `.select("amount.sum()")`
   style aggregate) so the query cost doesn't grow with a user's withdrawal history.
4. Keep the existing in-memory caches (`knownUsers` map in `bootstrapUser`, the 45s
   `settingsCache` in `getSettings`) — they're good, don't remove them, just don't defeat them by
   over-fetching from the client side.
5. Add a database index on `withdrawals (user_id, status)` — right now there's only an index on
   `(status, created_at desc)`, so any per-user withdrawal lookup (used in `getMe`, in
   `alertAdminsNewWithdrawal`, and in the admin panel) has to scan more than it should as the
   table grows.

## Problem 2 — "Mark paid" / "Reject" falsely says "Already reviewed"
Root cause found in `src/routes/admin.tsx`, inside the `Withdrawals` component: the **"Mark paid"**
and **"Reject"** buttons call `review(w.id, ...)` directly on `onClick` with **no disabled state
and no busy/loading guard** — unlike the "⚡ Auto pay" button right next to them, which already
correctly disables itself via a `paying` state while its request is in flight.

Because there's no guard, a slow network or an impatient extra tap sends the review request a
second time before the first one has finished. On the server, `reviewWithdrawal` in
`src/lib/payout.server.ts` does an atomic `update ... where status = 'pending'` and throws
`"Already reviewed"` whenever that `where` doesn't match a row anymore — which is exactly what
happens on the *second* of two near-simultaneous clicks, even though the withdrawal was never
actually completed by the admin's intent. The same underlying "no loading guard on click" pattern
also causes extra, redundant load on the backend and database every time it happens.

### What to change
1. Add a per-row busy state for **both** "Mark paid" and "Reject" (the same pattern the "Auto pay"
   button already uses with `paying`), so:
   - The button disables itself the instant it's clicked, before the network request starts.
   - It shows a clear loading label (e.g. "Marking paid…" / "Rejecting…") while in flight.
   - It re-enables only after the request settles (success or error), matching how `autoPay`
     already does it with its `finally` block.
2. Do not let `review()` fire again for the same withdrawal id while a request for that same id is
   already pending — guard this on the client (state) so no duplicate call can be sent even if the
   button is somehow clicked twice in the same tick.
3. Leave the server-side idempotency in `reviewWithdrawal` exactly as it is — the
   `where status = 'pending'` locking logic is correct and is exactly what protects against
   actually double-paying a withdrawal. Only the missing client-side loading guard needs fixing.

## Problem 3 — Every button needs a disabled + wait-cursor state
Across the app, most action buttons that trigger a server call are missing a loading/disabled
state, which lets users/admins tap repeatedly and send duplicate requests to the backend and
database. Audit and fix this everywhere a button (or tappable element) triggers a server function
or Supabase call, including but not limited to: `src/routes/index.tsx` (claim), `src/routes/trade.tsx`,
`src/routes/deposit.tsx`, `src/routes/withdraw.tsx`, `src/routes/friends.tsx`, `src/routes/gifts.tsx`,
`src/routes/account.tsx`, and every action in `src/routes/admin.tsx` (not just the withdrawal
review buttons above).

### What to change
1. Add a shared, reusable pattern (a small wrapper component or hook is fine) so every action
   button consistently, while its request is in flight:
   - Sets `disabled` so it cannot be tapped again.
   - Shows `cursor: wait` (e.g. a `cursor-wait` utility class) on the button itself, and ideally on
     `<body>`/the surrounding container for actions that block the whole screen, so it's visually
     obvious the app is working and discourages repeated taps anywhere.
   - Shows a short loading label or spinner in place of the normal button text, the same way the
     existing `autoPay`/broadcast "Sending…" and settings "Saving…" buttons already do — reuse that
     existing pattern rather than inventing a new one.
2. Make sure this loading state is scoped to the specific item being acted on (e.g. the specific
   withdrawal row, the specific user row) and not a single global flag that would freeze every
   button on the page for an unrelated action.
3. Don't change any business logic, amounts, or the payout/withdrawal review flow itself — this is
   purely about preventing duplicate/rapid-fire clicks from reaching the server and database.

## Verification
- Check code/build diagnostics after changes.
- Manually test: open the app cold and confirm it reaches a usable state noticeably faster, and
  confirm switching between Telegram foreground/background and between app screens doesn't
  trigger a burst of refetches.
- Manually test the admin panel: rapidly double-click "Mark paid" and "Reject" on a pending
  withdrawal and confirm only **one** request is ever sent, the button shows a loading state
  immediately, and "Already reviewed" no longer appears for a withdrawal that was never actually
  reviewed before.
- Spam-click a few other action buttons (claim, deposit, withdraw, friends, gifts, account, admin
  actions) and confirm each disables itself with a wait cursor on first click and only sends one
  request.
- Confirm the new `withdrawals (user_id, status)` index exists after migration and that the
  `getMe` withdrawal total is still numerically correct after switching to a database aggregate.

and remove /me command system in app.
