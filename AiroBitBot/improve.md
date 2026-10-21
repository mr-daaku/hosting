# AIROBIT — improve.md (full improvement pass)

Rules for this pass (follow exactly):
- Build everything below in ONE pass. Do not split into parts. Do not ask me anything before starting.
- Do NOT change the visual design or existing response shapes of server functions (frontend must keep working).
- Money rules stay: balance changes only through SQL functions (`change_balance`, etc.). Keep RLS ON with no policies.
- Use only what Lovable supports: TanStack Start server functions, Supabase SQL migrations, Lovable secrets (`process.env`), React Query. No Cloudflare Workers/KV.
- After finishing, give me a short list of what changed and any secrets I must add.

Priority: **P0 money/security → P1 DB load and speed → P2 features.**

---

## P0 — Money and security (do first)

### 1. Move wallet secrets out of the database
**Problem:** `hd_mnemonic`, `ton_hot_mnemonic`, `nodereal_api_key`, `toncenter_api_key` are stored in the `settings` table, and `adminGetSettings` returns them to the browser.
**Do:**
- Read them from `process.env` (Lovable secrets): `HD_MNEMONIC`, `TON_HOT_MNEMONIC`, `NODEREAL_API_KEY`, `TONCENTER_API_KEY`. Remove them from `DEFAULT_SETTINGS`/`SECRET_KEYS` usage in `core.server.ts` and every place that reads `s.hd_mnemonic` etc.
- `adminGetSettings` must return only booleans like `{ hd_configured: true, hot_wallet_configured: true }` plus the derived public addresses (`hotWallet`, `hdSample`). Never return a mnemonic or API key.
- Admin UI (`admin.tsx`): replace those input fields with read-only "Configured ✅ / Missing ❌" badges and a note: "Set in Lovable secrets".
- Add a one-time SQL cleanup: `delete from public.settings where key in ('hd_mnemonic','ton_hot_mnemonic','nodereal_api_key','toncenter_api_key');` (only after code reads from env).
- Move `ADMIN_IDS` to env `ADMIN_IDS` (comma separated), fallback to current values.

### 2. Fake ad rewards (client can call `claimAd` without watching)
**Problem:** `claimAd` trusts the client after Adsgram `done`. Anyone can call the server function directly every cooldown without watching ads.
**Do:**
- Create `src/routes/api/public/adsgram.ts` (GET). It receives Adsgram's server-side reward callback. Validate `secret` query param against env `ADSGRAM_SECRET` using `timingSafeEqual`, read `userid` (numeric), insert a row into `ad_credits` (see migration). Return 200.
- Tell me the exact Reward URL to paste in the Adsgram dashboard, e.g. `https://<app-domain>/api/public/adsgram?userid=[userId]&secret=<ADSGRAM_SECRET>` (use the placeholder name from Adsgram docs).
- `claimAd` now calls SQL function `claim_ad` (migration) which consumes one unused credit, checks daily limit and cooldown, and pays — all in one transaction.
- Client (`ads.tsx`): after `res.done`, retry `claim` up to 3 times with 1.5 s delay if the error is "Ad not verified" (webhook may arrive slightly later).
- Safe rollout: if env `ADSGRAM_SECRET` is NOT set, keep the old behavior and show a red warning in the admin panel: "Ad rewards are not verified server-side".
- `claim_ad` ignores credits older than 10 minutes. Add a daily cleanup of `ad_credits` older than 1 day.

### 3. Atomic daily claims
**Problem:** `claimDaily` marks the day as claimed first, then calls `change_balance`. If the second step fails the user loses the claim without reward.
**Do:** use SQL function `claim_daily` (migration). Server fn: call the RPC with kind and reward; if it returns `false` throw "Already claimed". Remove the separate `update` + `rpc`.

### 4. Withdraw: race condition and money-loss paths
**Problems:**
- Daily limit is `count` then `insert` (not atomic) → parallel requests bypass `daily_withdraw_limit`.
- Balance is deducted, then `insert` into `withdrawals`; if the insert fails the money is gone.
- `adminWithdrawAction` `reject` has no status guard → two quick clicks refund twice.
**Do:**
- Use SQL function `request_withdraw` (migration): advisory lock per user, limit check, deduct, insert — one transaction. Map error text containing "Insufficient" to the existing friendly message.
- In `adminWithdrawAction` reject: first do `update withdrawals set status='rejected' ... where id=$1 and status in ('pending','processing') returning id`; refund only if a row was returned. Same guard for `mark_paid`.

### 5. Auto payout safety (`sendTonUsdt`)
**Problems:** status becomes `paid` right after the message is sent, without confirmation. Two payouts at the same time can collide on `seqno`. A crash after sending leaves the row stuck in `processing`.
**Do:**
- Only one payout at a time: before sending, check there is no other withdrawal in `processing` newer than 2 minutes; otherwise leave it `pending` (retry later).
- After send, poll TonCenter for the wallet seqno/transaction up to ~20 s; mark `paid` only when confirmed, else keep `processing` with note "awaiting confirmation".
- Admin panel: show `processing` rows older than 5 minutes in red with buttons "Mark paid (enter hash)" and "Back to pending".
- Add admin setting `max_hot_wallet_float` and a warning on the admin dashboard showing the hot wallet balance (keep only small float there).
- Notify admins on Telegram (bot DM to `ADMIN_IDS`) when a withdrawal is pending or an auto payout fails.

### 6. `initData` hardening
**Do (`core.server.ts`, `verifyInitData`):**
- Compare hash with `timingSafeEqual`.
- Reduce max age from 7 days to 24 hours for normal calls; for `requestWithdraw`, `createTask` and admin functions require `auth_date` within 1 hour (return "Reopen the app" otherwise).
- Use the same timing-safe compare for the Telegram webhook secret in `telegram.ts`.

### 7. Rate limiting (also reduces DB load)
**Problem:** no limits anywhere; every call hits the database.
**Do:** add `rateLimit(key, max, windowMs)` helper in `core.server.ts` (in-memory Map, cleanup old keys). Apply:
| Function | Limit |
|---|---|
| all server fns (per user id) | 30 per 10 s |
| `checkDeposit` | 1 per 15 s per user (also store `users.last_deposit_check`) |
| `requestWithdraw`, `createTask` | 3 per minute |
| `detectTaskLink`, `checkBotAdmin` (call Telegram API) | 6 per minute |
| `claimTask` | 10 per minute |
Return a clear message "Too many requests, slow down". Note: in-memory limits are per server instance, so keep them generous; the SQL functions remain the real protection.

### 8. Task completion without verification
**Problem:** `bot`/`other` tasks and `check_sub=false` tasks can be claimed instantly.
**Do:** add `startTask(id)` server fn that stores `started_at` in a small table `task_starts(task_id, user_id, started_at)`. `claimTask` requires `now() - started_at >= 8 s` for unverified tasks and ≤ 1 hour. Frontend: "Open" button calls `startTask` then opens the link, then "Claim" appears after 8 s. Same idea for the "Check updates" daily task (server-side timer instead of the client-only `opened` flag).

### 9. Admin settings validation
**Problem:** `adminSaveSettings` does `Number(value)` with no range check; `NaN` can be saved.
**Do:** validate with zod per key: numbers must be finite and ≥ 0, `ref_percent` 0–100, `min_* ≤ max_*`, `withdraw_fee < min_withdraw`, `daily_withdraw_limit` ≥ 1, strings trimmed, links must be `https://`. Reject the whole save with a clear error.

### 10. Race in user creation
In `session.server.ts` the first-time `upsert(... ignoreDuplicates:false)` can overwrite `referrer_id` set by the Telegram webhook pre-registration. Change to insert with `onConflict: 'id', ignoreDuplicates: true`, then re-select the row.

---

## P1 — Less DB load, faster app

### 11. Indexes
Run the index block from the migration section below (missing: `task_completions(user_id)`, `tasks(status, created_at)`, `users(created_at)`, `users(total_earned)`, composite indexes for withdrawals, deposits, ledger).

### 12. `authLite` — remove one DB read from most calls
**Problem:** `auth()` does `select(*) from users` on every server function, even when only the user id is needed.
**Do:**
- Add `authLite(initData)` in `session.server.ts`: verify HMAC only, then check ban status from an in-memory set `bannedIds` refreshed every 30 s (`select id from users where banned = true`). No per-request DB query.
- Use `authLite` in: `listTasks`, `claimTask`, `myTasks`, `toggleMyTask`, `walletHistory`, `detectTaskLink`, `checkBotAdmin`, `createTask`, `startTask`.
- Keep full `auth()` only in `bootstrap`, `depositInfo`, `checkDeposit`, `requestWithdraw`, `referrals`. In `auth()` select only needed columns instead of `*`.
- Do NOT cache the user balance row anywhere.

### 13. `bootstrap`
- `totalUsers`: stop running `count(exact)` on every open. Cache it in memory for 60 s.
- Return the settings object from the existing 15–30 s settings cache (already there; keep).

### 14. `listTasks`
**Problem:** loads up to 200 tasks + up to 2000 completions per user and filters in JS.
**Do:** call SQL function `list_open_tasks(p_user, p_limit)` (migration). Keep the same response shape `{ reward, tasks }`. Limit 50 and add `offset` param later if needed. Cache `reward` from settings.

### 15. `adminStats`
**Problem:** loads up to 10,000 deposit and withdrawal rows and sums in JS (wrong after 10k rows, heavy).
**Do:** call SQL function `admin_stats()` (migration) and cache the result in memory for 60 s. Add a "Refresh" button that bypasses the cache.

### 16. Referral counters
**Problem:** `referrals` runs 2 count queries each time.
**Do:** use `users.ref_count` and `users.active_ref_count` (migration, maintained by triggers). `referrals` then needs only the paginated list query.

### 17. Cache expensive computations
- `bscAddress` uses `HDNodeWallet.fromPhrase` (heavy PBKDF2) on every `depositInfo`/`checkDeposit`. Derive once and store in `users.bsc_address`; read it from the user row afterwards.
- `tonPrice`: cache in a module variable for 60 s (CoinGecko rate limits). If the call fails use last good value, then `ton_price_fallback`.

### 18. React Query defaults (`router.tsx`)
`new QueryClient()` has no defaults, so history/myTasks/depInfo refetch on every mount and on every window focus (Telegram webview focus events). Set:
```ts
new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 } },
});
```
Per query: `me` 15 s, `tasks` 60 s, `history` 30 s, `myTasks` 30 s, `depInfo` 5 min.

### 19. Fewer refetches after actions
After `claimDaily`, `claimAd`, `claimTask`, update `["me"]` with `queryClient.setQueryData` using the returned `reward` (add reward to `withdraw_usdt` and `total_earned`, set the done flags) instead of `invalidateQueries`. Each invalidate currently triggers a full `bootstrap` (several DB queries). Remove the claimed task from the `["tasks"]` cache locally instead of refetching the list. Prefetch `["tasks"]` right after `bootstrap` succeeds.

### 20. Deposit detection
**Problems:** user must press "check"; each press scans the chain APIs; only the latest 100 (BSC) / 50 (TON) transfers are scanned, so spam/dust transfers can push a real deposit out of the window; deposits below `min_deposit` are skipped silently.
**Do:**
- Add a scheduled job route (the project already has `cron-auth.ts` / `authenticateCronRequest`): `src/routes/api/public/hooks/cron-deposits.ts` runs every 1–2 min for users who opened the deposit screen in the last 30 min (store `users.deposit_watch_until`, set in `depositInfo`). It uses the same scan + `record_deposit` logic. Frontend keeps the manual button as fallback.
- Show a message when a transfer was found but is below `min_deposit` ("Received X, minimum is Y — contact support").
- BSC scan: filter by token contract in the request if NodeReal supports it, otherwise page through results until a seen `tx_hash` is found.
- Admin: add a "Deposit addresses" tool listing the BSC per-user addresses that hold USDT/USDC so funds can be swept (funds currently stay on per-user addresses; no sweep exists).

### 21. Broadcast
`adminBroadcast` sends 25 messages per call in parallel and ignores `429`. Respect Telegram limits (≈ 25–30 msg/s): send in chunks of 20 with 1 s gap, handle `retry_after`, mark users who blocked the bot (`users.bot_blocked`) and skip them next time. Show sent/failed counters.

---

## P2 — Product improvements (pick all that fit)

| Feature | Notes |
|---|---|
| Bot DM to user on withdraw paid / rejected / deposit credited | use `tg("sendMessage")`, respect `bot_blocked` |
| Full transaction history for the user | read `ledger` (index added), 20 per page |
| Daily check-in streak | `users.streak`, `streak_date`; bonus at day 3/7/30 (admin-editable settings) |
| Leaderboard | top referrers / top earners, materialized view or cached query (60 s) |
| Task expiry and refund | when owner pauses/deletes or after N days, refund unused completions (`cost * remaining/max`) through `change_balance` with kind `task_refund` |
| Referral anti-abuse | admin view of users with many referrals created within minutes; optional `ref_active_threshold` plus minimum account age before `ref_active_reward` |
| Admin dashboard | charts (recharts is already installed): users/day, deposits/day, withdrawals/day, ledger sums |
| Admin audit log | table `admin_log(admin_id, action, payload, created_at)` for balance edits, bans, setting saves, withdraw actions |
| Languages | EN + HI (+ RU) with a simple dictionary and `language_code` from Telegram |
| Terms / FAQ / Support page | linked in the footer, text editable in admin settings |
| Error reporting | write server errors to table `error_log` (message, function, user id, time) and show last 50 in admin |
| Tests | vitest for `verifyInitData` (valid, wrong hash, expired), `rateLimit`, and settings validation |

---

## Migration (run as one SQL migration)

```sql
-- ===== Indexes =====
create index if not exists idx_tc_user on public.task_completions(user_id);
create index if not exists idx_tasks_status_created on public.tasks(status, created_at desc);
create index if not exists idx_users_created on public.users(created_at desc);
create index if not exists idx_users_earned on public.users(total_earned desc);
create index if not exists idx_wd_user_created on public.withdrawals(user_id, created_at desc);
create index if not exists idx_wd_status_created on public.withdrawals(status, created_at desc);
create index if not exists idx_dep_user_created on public.deposits(user_id, created_at desc);
create index if not exists idx_ledger_user_created on public.ledger(user_id, created_at desc);

-- ===== New columns =====
alter table public.users add column if not exists bsc_address text;
alter table public.users add column if not exists ref_count int not null default 0;
alter table public.users add column if not exists active_ref_count int not null default 0;
alter table public.users add column if not exists last_deposit_check timestamptz;
alter table public.users add column if not exists deposit_watch_until timestamptz;
alter table public.users add column if not exists bot_blocked boolean not null default false;

-- backfill referral counters
update public.users u set ref_count = c.n
  from (select referrer_id, count(*) n from public.users where referrer_id is not null group by 1) c
  where u.id = c.referrer_id;
update public.users u set active_ref_count = c.n
  from (select referrer_id, count(*) n from public.users where referrer_id is not null and is_active_ref group by 1) c
  where u.id = c.referrer_id;

create or replace function public.trg_ref_counters() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op = 'INSERT' then
    if new.referrer_id is not null then
      update public.users set ref_count = ref_count + 1 where id = new.referrer_id;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.is_active_ref and not old.is_active_ref and new.referrer_id is not null then
      update public.users set active_ref_count = active_ref_count + 1 where id = new.referrer_id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists users_ref_counters on public.users;
create trigger users_ref_counters after insert or update of is_active_ref on public.users
  for each row execute function public.trg_ref_counters();

-- ===== Ad credits (server-verified ads) =====
create table if not exists public.ad_credits (
  id bigserial primary key,
  user_id bigint not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_ad_credits_user_unused on public.ad_credits(user_id) where used = false;
alter table public.ad_credits enable row level security;
grant all on public.ad_credits to service_role;
grant usage, select on sequence public.ad_credits_id_seq to service_role;

-- ===== Task starts (anti-instant-claim) =====
create table if not exists public.task_starts (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id bigint not null,
  started_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
alter table public.task_starts enable row level security;
grant all on public.task_starts to service_role;

-- ===== Functions =====
create or replace function public.claim_ad(p_user bigint, p_limit int, p_cooldown_sec int, p_reward numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.users; cid bigint; cnt int;
begin
  select * into u from public.users where id = p_user for update;
  if u.id is null then raise exception 'User not found'; end if;
  cnt := case when u.ads_date = current_date then u.ads_today else 0 end;
  if cnt >= p_limit then raise exception 'Daily ad limit reached'; end if;
  if u.last_ad_at is not null and now() - u.last_ad_at < make_interval(secs => greatest(p_cooldown_sec - 3, 0)) then
    raise exception 'Please wait before next ad';
  end if;
  select id into cid from public.ad_credits
    where user_id = p_user and not used and created_at > now() - interval '10 minutes'
    order by id limit 1 for update skip locked;
  if cid is null then raise exception 'Ad not verified'; end if;
  update public.ad_credits set used = true where id = cid;
  update public.users set ads_today = cnt + 1, ads_date = current_date, last_ad_at = now() where id = p_user;
  if p_reward > 0 then
    perform public.change_balance(p_user, 0, p_reward, 'ad', 'Ad view', true);
  end if;
  return jsonb_build_object('reward', p_reward, 'ads_today', cnt + 1, 'last_ad_at', now());
end $$;

create or replace function public.claim_daily(p_user bigint, p_kind text, p_reward numeric, p_ads_target int default 0)
returns boolean language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if p_kind = 'checkin' then
    update public.users set last_checkin = current_date
      where id = p_user and (last_checkin is null or last_checkin <> current_date);
  elsif p_kind = 'updates' then
    update public.users set updates_claimed = true where id = p_user and updates_claimed = false;
  elsif p_kind = 'ads' then
    update public.users set ads_task_date = current_date
      where id = p_user and (ads_task_date is null or ads_task_date <> current_date)
        and ads_date = current_date and ads_today >= p_ads_target;
  else
    raise exception 'Bad kind';
  end if;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  if p_reward > 0 then
    perform public.change_balance(p_user, 0, p_reward, 'daily_' || p_kind, p_kind, true);
  end if;
  return true;
end $$;

create or replace function public.request_withdraw(p_user bigint, p_amount numeric, p_fee numeric, p_address text, p_memo text, p_daily_limit int)
returns uuid language plpgsql security definer set search_path=public as $$
declare wid uuid;
begin
  perform pg_advisory_xact_lock(p_user);
  if (select count(*) from public.withdrawals where user_id = p_user and created_at >= date_trunc('day', now())) >= p_daily_limit then
    raise exception 'Daily withdraw limit reached';
  end if;
  perform public.change_balance(p_user, 0, -p_amount, 'withdraw', p_address);
  insert into public.withdrawals(user_id, amount, fee, address, memo)
    values (p_user, p_amount, p_fee, p_address, p_memo) returning id into wid;
  return wid;
end $$;

create or replace function public.list_open_tasks(p_user bigint, p_limit int default 50)
returns table(id uuid, type text, title text, link text, check_sub boolean, max_completions int, completions int)
language sql stable security definer set search_path=public as $$
  select t.id, t.type, t.title, t.link, t.check_sub, t.max_completions, t.completions
  from public.tasks t
  where t.status = 'active'
    and t.completions < t.max_completions
    and (t.owner_id is null or t.owner_id <> p_user)
    and not exists (select 1 from public.task_completions c where c.task_id = t.id and c.user_id = p_user)
  order by t.created_at desc
  limit p_limit;
$$;

create or replace function public.admin_stats()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'users', (select count(*) from public.users),
    'usersToday', (select count(*) from public.users where created_at >= date_trunc('day', now())),
    'activeTasks', (select count(*) from public.tasks where status = 'active'),
    'pendingW', (select count(*) from public.withdrawals where status = 'pending'),
    'completions', (select count(*) from public.task_completions),
    'totalDeposits', (select coalesce(sum(usd_amount), 0) from public.deposits),
    'totalPaid', (select coalesce(sum(amount), 0) from public.withdrawals where status = 'paid')
  );
$$;

-- ===== Permissions =====
revoke execute on function public.claim_ad, public.claim_daily, public.request_withdraw,
  public.list_open_tasks, public.admin_stats, public.trg_ref_counters from public, anon, authenticated;
grant execute on function public.claim_ad, public.claim_daily, public.request_withdraw,
  public.list_open_tasks, public.admin_stats to service_role;
```

---

## Acceptance checklist
- [ ] No mnemonic/API key is stored in `settings` or returned to the browser
- [ ] `claimAd` fails without a server-verified ad credit (when `ADSGRAM_SECRET` is set)
- [ ] `claimDaily`, `requestWithdraw`, `claimAd` use SQL functions (single transaction)
- [ ] Reject/mark-paid cannot run twice on the same withdrawal
- [ ] `initData` max age 24 h (1 h for withdraw/create/admin), timing-safe compare
- [ ] Rate limits applied, with friendly error
- [ ] Indexes created, `authLite` used on light endpoints, `bootstrap` count cached
- [ ] `listTasks` and `adminStats` use SQL functions, `adminStats` cached
- [ ] QueryClient defaults set, no `invalidate` storm after claims
- [ ] Deposit cron + cooldown, `bsc_address` cached, TON price cached
- [ ] Existing UI and all current features still work
