# CoCoTaskBot — Deposit fix + new admin/task/spin systems

You are working on the existing **CoCoTaskBot** Telegram Mini App (TanStack Start + Supabase, server functions in `src/lib/coco.functions.ts`, store in `src/lib/coco-store.tsx`, admin UI in `src/routes/admin.tsx`, wallet in `src/routes/wallet.tsx`).

Implement **every** item below. **Nothing may be skipped, stubbed, or left as a TODO.** The most important item is **Section 1 (Deposit)** — do it first and do it completely. When everything is built, **verify it yourself** (Section 8) and report honestly what was verified and what could not be.

## Ground rules

- Keep the existing framework, design system and file structure. No unrelated refactors, no new dependencies unless truly required (`@ton/core` is already installed).
- All balance changes stay **server-side**. Telegram identity is verified server-side (`assertUser` / `requireAdmin`) on every function. Never trust a user ID sent by the client.
- Database changes go through the project's existing migration mechanism (same way as `drizzle/migrations/0000_atomic_deposit_confirmation.sql`). New SQL functions must follow the same pattern: `SECURITY DEFINER`, `SET search_path = public`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`. Regenerate `src/integrations/supabase/types.ts` afterwards.
- Keep the mobile Telegram layout (narrow screen, charcoal + lime style). Every new button/input follows the existing components (`ActionButton`, `Input`, `AlertDialog`, `SubTabs`).
- Preserve everything that works today (referrals, promo, ads, withdrawals, payouts, broadcast, settings).

---

## 1. DEPOSIT SYSTEM — must auto-credit after wallet payment (highest priority)

### Current problem
User taps the deposit button → TON wallet opens → user pays → returns to the app → sees **"Payment sent. Confirming on the network…"** but the Gram balance is **never credited**. Tapping **"I already paid — check now"** also does not credit.

### Required behavior
1. After the user pays in the wallet and returns to the app, the deposit is **credited automatically** as soon as the payment is visible on the TON blockchain (normally 5–20 seconds). No button press needed.
2. **Remove the "I already paid — check now" button completely** (and its handler/state).
3. The user must see a clear live status: *Waiting for wallet → Confirming on the network → Credited (+X Gram)*. It must never get stuck on "Confirming…" forever.
4. If the user closes the app right after paying, the deposit must still be credited automatically by the backend (Section 1.4).

### Non-negotiable safety rule
**Do NOT credit Gram just because the wallet callback (`sendTransaction` resolved) fired.** A resolved callback is not proof of payment (it can be faked by calling the server function directly, or the transaction can fail/bounce). Credit **only** after the server has verified the transaction on-chain. "Direct deposit" is achieved by making verification fast, automatic and reliable — not by skipping it.

### Likely root causes found in the current code (confirm each with server logs, then fix)
| # | Where | Problem |
|---|---|---|
| a | `checkDepositFn` with `wait: true` | Runs a 6 × 5 s `sleep` loop **inside one HTTP request** (~30 s+) that starts at the exact moment the user returns from the wallet. Telegram's WebView is resuming/backgrounded, the request is aborted/times out, the UI stays on "Confirming…" and nothing retries. |
| b | `wallet.tsx` | `beginDeposit` is called **after** `sendTransaction`. If the app is closed/reloaded in between, no attempt exists. After a reload `attemptId` is `undefined`, so "check now" has no context. |
| c | `checkDepositFn` matching | Requires `abs(amount − expected_amount) ≤ 1e-9` and one static memo `CC-<userId>` for all attempts. Any amount edited in the wallet, or several attempts, means no match. |
| d | `checkDepositFn` matching | Uses `ev.actions.find(...)` — only the **first** `TonTransfer` action of an event is inspected, and recipient/status are never checked. |
| e | `fetchTonEvents` | Single provider (TonAPI, `limit=100`), free tier is rate limited (429) without `TONAPI_KEY`; a failure returns a terminal error to the user. |
| f | RPC credit path | `credit_verified_deposit` updates `app_users.gram` but the write-through user cache (`cacheKeys.user`) is not refreshed, so the balance can lag. |
| g | No background job | Nothing credits a deposit unless the user's app is open and polling. |

Before changing code, log a **real sample response** from the provider for the deposit address (redact nothing but keys) so the parser is written against the actual field names, not assumptions.

### 1.1 Server changes (`coco.functions.ts` + a new `src/lib/ton-deposits.server.ts`)
- **`beginDepositFn`** — now called **before** opening the wallet. Validates `amount >= settings.minDeposit`, creates a `pending` row in `deposit_attempts`, and returns `{ attemptId, address, memo, amountNano }` where `address` = server-side `settings.depositAddress` (server is the single source of truth; the client must use this, not a hard-coded constant) and `memo = "CC-<userId>"`. Expire this user's older pending attempts (> 30 min) first.
- **`cancelDepositFn`** — marks an attempt `expired` when the user rejects/cancels in the wallet.
- **`checkDepositFn`** — rewrite as a **single-shot, fast (< 8 s), no-sleep** call. Remove the `wait` parameter and the sleep loop. It runs `reconcilePendingDeposits(sb, { userId })` and returns `{ status: "idle" | "pending" | "confirmed" | "error", credited, user }`. A provider error/429 returns `pending` (retryable) and is logged server-side — never a terminal failure.
- **`reconcilePendingDeposits(sb, { userId? })`** (shared by `checkDepositFn` and the cron job):
  ```
  attempts = deposit_attempts WHERE status='pending' AND created_at > now()-24h   (optionally for one user)
  if none -> return idle
  txs = fetchIncomingTransfers(depositAddress)      // provider layer, see below
  for each user with pending attempts:
     candidates = txs where
        recipient == depositAddress   (compare with Address.parse(...).toRawString() from @ton/core)
        AND comment === "CC-<userId>"
        AND transfer/tx status is success
        AND tx time >= attempt.created_at - 120s
        AND tx hash NOT in processed_transactions
     pass 1: give each attempt (oldest first) the candidate with the SAME amount in nanoton (integer compare)
     pass 2: give remaining attempts the earliest remaining candidate (user edited the amount in the wallet)
     credit the ACTUAL received amount via rpc credit_verified_deposit(p_user_id, p_tx_hash, p_memo, p_amount, p_attempt_id)
     23505 (already processed) -> treat as already credited, not an error
  after every credit: refresh the user cache (cacheSet cacheKeys.user) so the balance is instantly correct
  ```
  Requiring a pending attempt (created **before** the wallet opened) is intentional: it prevents double-crediting old deposits that admins already credited manually with `adminCreditDeposit` (those have no tx hash in `processed_transactions`).
- **Provider layer `fetchIncomingTransfers`**: primary **TonAPI** (`/v2/accounts/{address}/events`, use `TONAPI_KEY` when set), automatic **fallback to TonCenter v3** (optional `TONCENTER_API_KEY`) if TonAPI errors or returns 429. Inspect **all** actions of each event, not just the first. Max one short retry (≤ 1 s) — never long sleeps. Normalize both providers into `{ hash, timeSec, recipientRaw, senderRaw, amountNano, comment, ok }`.
- Confirm `processed_transactions.tx_hash` has a **UNIQUE/PRIMARY KEY** constraint in the real database (idempotency depends on it); add it if missing.
- `bootstrap` must also return the user's latest `pending` attempt (≤ 30 min old) as `pendingDeposit`, so the watcher resumes after the app is reopened.

### 1.2 Background reconciliation (deposit credited even if the user leaves)
- Add a protected route `src/routes/api/public/hooks/reconcile-deposits.ts` (POST) secured with the existing `authenticateCronRequest` (`src/integrations/supabase/cron-auth.ts`, secret `LOVABLE_CRON_SECRET`).
- It calls `reconcilePendingDeposits(sb)` for all users with pending attempts, marks attempts older than 24 h as `expired`, and sends the user a Telegram message via the existing `tg("sendMessage")` helper: "✅ Deposit confirmed: +X Gram" (do not fail the job if Telegram delivery fails).
- Schedule it **every minute** using the project's supported scheduling mechanism, and tell me exactly what was scheduled and how.

### 1.3 Client changes (`wallet.tsx`, `coco-store.tsx`)
- Deposit button flow:
  1. validate amount → `beginDeposit` (server) → get `attemptId/address/memo`;
  2. `tonConnectUI.sendTransaction({ validUntil: now+600s, messages: [{ address, amount: String(amountNano), payload: commentPayload(memo) }] })`;
  3. if the wallet rejects → call `cancelDeposit`, toast "Payment cancelled";
  4. if it resolves → immediately set status "Confirming on the network…" and start the watcher. **No credit yet.**
- **Global deposit watcher inside `CocoProvider`** (so it keeps running when the user navigates to other pages), active whenever a pending attempt exists:
  - poll `checkDeposit` every **3 s** for the first 3 min, then every **15 s** until 30 min, then stop (the cron keeps going server-side);
  - sequential polling (never overlapping requests), each request with `AbortSignal.timeout(15000)`;
  - also check **immediately** on `visibilitychange` → visible, window `focus`, and Telegram WebApp `activated` event (this is the moment the user returns from the wallet), and on app start when `pendingDeposit` exists.
- On `confirmed`: update the balance instantly everywhere, refresh deposit history, show toast "✅ +X Gram deposited", show final status text, trigger Telegram haptic success if available. Stop polling.
- After 3 min without confirmation show a neutral text (no button): "Still confirming on the network. You can leave this screen — your balance updates automatically." Show the pending deposit as **Pending** with a spinner in Deposit history.
- Remove the old "Payment sent… / Still confirming. Tap 'I already paid'…" strings and the `depositState === "delayed"` dead end.

### 1.4 Configuration checks (report the result)
- `TONAPI_KEY`, `TON_DEPOSIT_ADDRESS`, `TELEGRAM_BOT_TOKEN`, `LOVABLE_CRON_SECRET` present? Recommend setting `TONAPI_KEY` (free tier rate-limits).
- The TonConnect manifest URL/origin (`public/tonconnect-manifest.json`, `__root.tsx`, `PUBLIC_SITE` in `telegram.server.ts`) currently point to `glad-spark-nexus.lovable.app`, while the README mentions `cocotaskbot.lovable.app`. Find which is the real published domain and make **all** of them consistent. Keep `twaReturnUrl: "https://t.me/CoCoTaskBot/app"` and `returnStrategy: "back"`.

---

## 2. ADMIN TASK APPROVAL — every task type must be approved by an admin

Requirement: **All user-created tasks — Channel, Bot and Other — must stay pending until an admin approves them.** No category may go live automatically.

- `createTaskFn`: force `status: "pending"` for every category regardless of input; never accept a status from the client.
- Database: make sure `anon`/`authenticated` roles have **no** INSERT/UPDATE/DELETE on `tasks`, `app_users`, `transactions`, `deposits`, `deposit_attempts`, `processed_transactions`, `task_completions`, `withdrawals` (RLS + grants; only `service_role`). Fix anything permissive. Report what you found.
- Server feed: `bootstrap` currently returns **all** tasks to every user. Return only `active` tasks **plus the caller's own tasks** (all statuses) to normal users; admins get everything through `adminData`.
- `completeTaskFn` must keep rejecting anything that is not `active` (also covers `paused`).
- UI: on the Create Task form rename "Fund and publish" → **"Submit for approval"**; success message "Task submitted. Waiting for admin approval."; in **My tasks** show status labels Pending / Active / Paused / Rejected / Done.
- Admin → Tasks: default to **Pending** sub-tab, and show a pending-count badge on the "Tasks" tab so nothing is missed. Existing Approve / Reject (with "Refund unused slots when rejecting") stays.
- Admin-created partner tasks (`adminCreateTaskFn`) remain instantly active (they are created by an admin).

---

## 3. PAUSE / RESUME / DELETE running tasks

Admin → Tasks → **Running** currently only has **Delete**. Add **Pause** and **Resume**.

- New task status **`paused`**. Update `DbTask["status"]`, any DB CHECK constraint on `tasks.status`, and generated types.
- `adminSetTaskStatus`: allow only valid transitions `active → paused` and `paused → active`; keep the `completed` count and slots untouched; call `invalidateTaskFeed()`.
- Paused tasks are **hidden from users' task lists** and cannot be claimed. Progress is preserved and Resume makes the task visible again.
- Running sub-tab shows both `active` and `paused` tasks; paused ones get a "Paused" badge and a **Resume** button; active ones get **Pause** + **Delete**.
- **Delete** keeps its confirmation dialog and now also offers the existing "Refund unused slots" option (creator gets back `remaining slots × defaultTaskPrice` Gram, never for partner tasks; log a `refund` transaction). Deleting must also remove that task's `task_completions` (FK cascade or explicit) and invalidate the feed cache.

---

## 4. USER SEARCH — by Telegram username, Telegram ID and display name

Admin → Users search currently only matches an exact `tg_id`.

- Placeholder: **"Search by Telegram ID, @username or name"**.
- `adminSearchUser` returns a **list (max 20)** of matches, using separate safe queries (do **not** build a PostgREST `.or()` string from raw input):
  1. all digits → exact `tg_id`;
  2. `@name`, `t.me/name`, or a plain word → case-insensitive **exact** `username` (strip `@`, `t.me/`);
  3. otherwise / in addition → **partial, case-insensitive match on `name`** (this is how users **without a username** are found). Escape `%`, `_` and `\` in `ilike` patterns.
- UI: if 1 result open it directly; if several show a compact list (name, @username or "no username", ID) — tap to open the existing user card. The card also shows @username, join date, banned state and bonus spins.
- **Data freshness fix**: `bootstrap` currently updates `username` only when present and never updates `name` after creation. On every bootstrap update `name` and set `username` (or `null` when the user has none).
- Add an index on `lower(username)`.

---

## 5. SPIN MANAGEMENT — admin can give spins to a user

There is currently no way for an admin to add spins.

- DB: add `app_users.bonus_spins integer NOT NULL DEFAULT 0 CHECK (bonus_spins >= 0)`.
- SQL functions (atomic, service_role only):
  - `grant_bonus_spins(p_user_id text, p_delta int) returns int` — `bonus_spins = greatest(0, bonus_spins + p_delta)`, returns the new value;
  - `consume_bonus_spin(p_user_id text) returns boolean` — decrements only if `bonus_spins > 0`.
- `spinFn` accepts `source: "free" | "ad" | "bonus"`. For `bonus`: call `consume_bonus_spin` **before** rolling; if it returns false → "No bonus spins left."; if the roll/credit then fails, give the spin back. Rewards and the existing free/ad spin logic stay unchanged.
- Spin page: show a "Bonus spins: N" line; button priority: **Free spin → Bonus spin → Ad spin**; label "Use Bonus Spin". Balance state includes `bonusSpins`, updated instantly after a spin.
- Admin → Users card: add a third field **"Spins ±"** (integer, negative allowed) next to "CoCo ±" and "Gram ±". **Apply** handles all three; toast says exactly what changed. Log a `transactions` row for spin changes (`type: "admin"`, note `Admin spin grant: +N`; use an existing valid currency value and `amount: 0` if the currency column is constrained).
- While in `adminAdjustUser`: it currently logs only one transaction row when both CoCo and Gram change. Write **one row per currency** changed.

---

## 6. Small related fix — enforce bans server-side

The "Ban" button sets `app_users.banned`, but `assertUser` never checks it, so a banned user can still use the app. Add a server-side check (cache the lookup for ~5 s) that blocks banned, non-admin users from all actions with the message "Your account is restricted."; the app should show that message instead of an endless loader.

---

## 7. Do not break

Referral commission, promo codes, daily tasks, ads (Monetag/Adsgram), Earn page, withdrawals + payout flow, broadcast, admin settings, leaderboard, welcome message. Keep all existing copy and styling unless changed above.

---

## 8. VERIFY BEFORE YOU FINISH (mandatory)

After building, verify each item yourself and finish with a table: **Item | How verified | Result (Verified / Blocked-needs-live-test)**. Be honest — do **not** claim a live TON payment or Telegram session was tested if it was not.

Required checks:
1. Build, type-check and lint pass; no runtime/server errors in logs.
2. **Unit tests for the deposit matcher** using fixture events: correct memo+amount → credited once; second call → not credited twice; wrong memo; wrong recipient; failed transaction; multi-action event; amount edited in wallet; transaction older than the attempt; provider 429 → fallback provider → `pending` not error; two concurrent checks (client + cron) → single credit.
3. `checkDepositFn` returns in under 8 s with no sleep loop; watcher stops on confirm, resumes after reload with `pendingDeposit`, and no "I already paid" button exists anywhere (`grep`).
4. Cron route rejects requests without the secret and works with it; report the schedule.
5. Task approval: creating Channel, Bot and Other tasks all end up `pending`; users cannot see other people's pending tasks; pause hides a task, resume restores it, delete asks for confirmation and refunds correctly.
6. User search: by ID, by `@username`, by name (user without username), partial name, no result, special characters in the query.
7. Spins: grant, negative grant (never below 0), consume, and no double-spend when tapping fast (atomic function).
8. Ban actually blocks server actions.
9. Regenerated types match the migrations; RLS/grants audit result reported.

Finally, give me a **short manual test checklist** to run inside Telegram with a real small TON payment (minimum deposit), covering: pay → return → balance updates automatically; close app right after paying → balance still updates and Telegram message arrives; cancel in wallet → no credit.

and add a option in tasks (admin panel) create partner task.
