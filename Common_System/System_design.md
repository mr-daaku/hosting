# system_design.md — OpalineAI (repo-rhymes): Scale, Speed & Security

> Audience: Lovable AI. Owner: Gaurav. Written after reading the real repo (server functions, SQL migrations, cron, deposit/payout code, routes).
> Goal: the app must stay fast and not crash when many users open it at once, with low database load, caching, smooth UI and strong security.

---

## 0. Rules for Lovable (read first)

**Workflow**
- Build **Phase 0 fully in one pass**, then re-read this file, fill gaps, run `bun run test` and `bun run build:cf`, then reply. Do the same for Phase 1 / Phase 2 only when the owner asks.
- Phase 0 needs **no new paid service and no new secret**. Phase 1 and 2 list exactly which secrets/bindings they need. Use secrets the owner gives directly, don't ask again.
- Anything marked **OWNER DECISION**: implement the stated safe default and list it in your final reply.
- Anything marked **VERIFY**: check it in the real project before relying on it; if it doesn't hold, use the stated fallback.

**Non-negotiables (from AGENTS.md — do not change)**
1. All tables keep RLS on with no client policies; every read/write goes through server functions with the service-role client.
2. Every balance change happens inside a Postgres function that locks the balance row and writes `ledger_entries`.
3. Identity comes only from server-validated Telegram `initData` → HMAC session token. Never trust a client-sent user id.
4. Admin only when verified Telegram id == `ADMIN_TELEGRAM_ID`.
5. User-facing copy never promises guaranteed returns.
6. Cloudflare build: `bun run build:cf`; `wrangler.jsonc` name must match the Worker; do **not** set `sideEffects:false`.
7. Keep payouts idempotent: pending → processing → paid, never twice.

**Cache safety rule:** never cache balances, withdrawals, ledger or any per-user money data in a shared cache. Shared cache = global data only (settings, tiers, prices, results). Per-user cache keys must include the user id and live max 10 s, in isolate memory only.

---

## 1. How the app works today (verified from code)

| Layer | What it is |
|---|---|
| Client | React 19 + TanStack Start/Router/Query, Telegram Mini App, 8 languages, Turnstile on open |
| Server | TanStack Start server functions on a Cloudflare Worker (`opalineai`, nitro, `nodejs_compat`) |
| DB | Supabase Postgres, accessed only via `supabase-js` (PostgREST) with service-role key; money logic in `plpgsql` functions |
| Cache | `cached()` in `core.server.ts` = a `Map` **inside one isolate** (settings 20 s, users 10 s, prices 60 s, channels 120 s) |
| Background | 2-minute cron → `scan-deposits`; Telegram webhook → `/api/public/telegram` |
| External | Telegram Bot API, NodeReal (BSC/ETH), TonCenter (GRAM), Binance/OKX/Coinbase prices, BSC RPC (auto pay), Cloudflare Turnstile |

**Request flow**

```
Telegram WebView
   │  initData
   ▼
login()  ──► rate_hit (DB write) ► ensure_user (DB) ► users.update last_seen (DB write) ► Turnstile siteverify
   ▼
bootstrap() ► users select * ► accrue_shards (DB WRITE + global row lock) ► boot_state ► daily_results ► settings ► promo_budget_days
   ▼
each screen/action ► requireUser (users select *) ► rate_hit (DB write) ► RPC / selects ► Telegram message (not awaited)
```

**Database round-trips counted from the code (not measured traffic):**

| Moment | DB calls |
|---|---|
| App open, cold isolate cache | ≈ 9 (login 3 + bootstrap 6) + Telegram `getChatMember` per required channel |
| App open, warm isolate cache | ≈ 4 (login's 3 are never cached) |
| Buy 10 crystals | ≈ 14 (10 sequential RPCs + rate_hit + 2 selects) |
| Team screen | 4 queries, up to 500 referral rows pulled into JS |
| Withdraw request | ≈ 6 + 3 selects pulling **all** deposits/withdrawals rows of the user |

---

## 2. Bottlenecks and risks found

| # | Where | Finding | Why it hurts at scale | Fix |
|---|---|---|---|---|
| B1 | `core.server.ts cached()` | Per-isolate `Map`; no single-flight; every new isolate starts cold | Cache hit rate falls as traffic grows (more isolates); on expiry many concurrent requests hit DB together (stampede) | 4.1, 5.1 |
| B2 | `bootstrap` | Calls `accrue_shards` (a **write**) on every boot, comment says "display only". It locks `promo_budget_days` row `FOR UPDATE` — **one global row for all users** | All users serialize on one row → global ceiling = 1 / transaction time | 4.2 |
| B3 | `login` | 3 uncached DB calls (one is a write on `users`), `last_seen_at` updated on every login (+ every 50 min re-login); waits up to 2.5 s for Turnstile **before** login | Slow first paint, write load grows with users | 4.3, 4.7 |
| B4 | `rate_hit` | Every limited call = DB write on `rate_limits`; `rate_limits` and `webhook_events` are never cleaned | DB write per request; tables grow forever | 4.5 |
| B5 | `buyCrystal`, `team`, `checkFreeWithdraw`, `crystalRecords` | Loops of RPCs, JS-side joins/sums, full-table pulls per user | Many round-trips; CPU in Worker; slow for heavy users | 4.4 |
| B6 | `tgSend` / `notifyUser` | Called without `await`/`waitUntil` | On Workers un-awaited work can be cut when the response ends → lost messages; also uncontrolled Telegram concurrency | 4.6, 5.3 |
| B7 | `adminBroadcast` | Sequential loop, 40 ms each, `limit(20000)` in **one request** | ≈ 13+ min for 20k users, will time out; silently skips users above 20k | 5.3 |
| B8 | `missingChannels` | `getChatMember` per user per channel, cached 2 min in isolate only | Telegram rate limits; fails open (users pass) when limited | 5.1 |
| B9 | `deposits.server.ts` | Cron scans only top 200 users by `last_seen`; GRAM reads only last 50 tx, no cursor; TonCenter used without API key | Users beyond 200 are never scanned by cron; deposits can be missed when >50 tx between runs | 5.4 |
| B10 | `prices()` | Up to 5+ external calls per isolate per minute with fallback chain | Many isolates × many calls → provider 429/geo-blocks | 5.2 |
| B11 | `payout.server.ts` | Auto pay runs **inside the user's request** (waits up to 24 s for receipt); nonce read from `pending` per call; on error after broadcast it resets status to `pending` | Concurrent payouts can collide on nonce; a broadcast-then-error can be paid twice by admin | 6.1 |
| B12 | Frontend | Google Fonts render-blocking; all 8 language dictionaries + `recharts` possibly in main bundle (**VERIFY**); every mutation refetches full `boot`; `useSuspenseQuery(tiers)` waterfall; no immutable cache headers (**VERIFY**) | Slower first load on mobile networks | 4.9, 4.10 |

**Security findings (details in section 7):**

| # | Finding | Severity |
|---|---|---|
| S1 | `verifyInitData`: if `BOT_TOKEN` is missing it logs in **everyone** as demo user id 1 (fails open) | High (only if env is ever missing in prod) |
| S2 | Free-withdraw allowance checked in JS **before** the RPC → two parallel requests can both pass (race) | High (money) |
| S3 | No runtime validation of server-function inputs (`inputValidator((d)=>d)` only casts types) | Medium |
| S4 | `JWT_SECRET` falls back to a value derived from the service-role key | Medium |
| S5 | Signature/secret compared with `!==` (not constant time) | Low |
| S6 | `banned` is checked from a 10 s isolate cache, not inside money functions | Medium |
| S7 | Turnstile token is optional at login → it adds no protection today (only decorative) | Info (OWNER DECISION) |
| S8 | `WALLET_MNEMONIC` and `PAY_WALLET_SECRET` live in the same Worker as the public API | Medium |
| S9 | No security headers / CSP | Low–Medium |

**Already good (keep):** RLS deny-all, HMAC initData verification, CSRF middleware on server fns, row-locked money functions + ledger, idempotency keys (`unique(user_id, client_request_id)`), deposit dedup `(chain, tx_hash, log_index)`, timing-safe cron auth, webhook secret check, server-signed withdrawal captcha, error codes whitelist (no DB errors leaked).

---

## 3. Target architecture

```
Telegram WebView
   │
   ▼
Cloudflare edge ── static assets: immutable cache, brotli
   │
   ▼
Worker (server fns)
   ├─ L1 isolate memo (≤ 20 s, single-flight)
   ├─ L2 shared cache (KV or Upstash)      ← global data only      [Phase 1]
   └─ Supabase Postgres (RPC only, few calls per screen)
   
Outbox table ──► drain cron ──► Telegram API (≤ 25 msg/s)         [Phase 1]
Cron: refresh-prices / scan-deposits (round-robin) / cleanup      [Phase 1]
Payout drain (single worker, stored raw tx)                       [Phase 2]
```

**Shared cache choice (architecture comparison)**

| Option | Shared across isolates | Consistency | Cost/complexity | Good for | Verdict |
|---|---|---|---|---|---|
| Isolate memory (today) | No | Exact per isolate | Free | Tiny hot data | Keep as L1 |
| Cloudflare Cache API | Per data center only | Per colo | Free, needs synthetic GET keys | Public GET data | Optional |
| Cloudflare KV | Global | Eventual (changes can take up to ~60 s) | Cheap, binding needed | settings, tiers, prices, results | **Recommended L2** if bindings are reachable |
| Upstash Redis (REST) | Global | Strong | Paid per request, just `fetch` + 2 secrets, works on any host | Cache + counters + locks | **Fallback L2** (works on Lovable hosting and Cloudflare) |
| Durable Objects | Global, single-threaded | Strong | Most complex | Exact global counters, payout lock | Only if needed later |
| DB-only (today) | — | Strong | Load on the one DB | Money state | Keep for money |

**VERIFY:** can server functions in this nitro/TanStack Start build read Worker bindings (e.g. `env.CACHE`)? If yes use KV. If not, use Upstash (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). The code must auto-detect and fall back to L1-only if neither exists, so the app never breaks.

---

## 4. Phase 0 — code-only fixes (no new infra) · do first

### 4.1 `cached()` with single-flight and stale-if-error

Replace in `core.server.ts` (keep `bust`, `bustPrefix`):

```ts
const memo = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string, ttlMs: number, fn: () => Promise<T>, opts?: { swrMs?: number },
): Promise<T> {
  const hit = memo.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < ttlMs) return hit.v as T;

  const refresh = (): Promise<T> => {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn()
        .then((v) => { memo.set(key, { at: Date.now(), v }); trim(); return v; })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };

  // serve stale while one background refresh runs
  if (hit && opts?.swrMs && age < ttlMs + opts.swrMs) { void refresh().catch(() => {}); return hit.v as T; }
  // stale-if-error: if refresh fails but we have an old value, return it
  try { return await refresh(); } catch (e) { if (hit) return hit.v as T; throw e; }
}
function trim() { if (memo.size > 5000) memo.delete(memo.keys().next().value as string); }
```

Use `swrMs` on settings, tiers, results, prices (e.g. `ttl 20 s, swr 60 s`).
Also memoize `evmAddress(index)` results in a `Map` (immutable per index) to save CPU.

### 4.2 Stop writing on every boot (removes the global lock from the hot path)

- Remove the `accrue_shards` call from `bootstrap`. Money-changing functions (`collect_*`, `buy_crystal`, `redeem_crystal`, `request_withdrawal`, `perk_apply`) keep calling `accrue_shards` internally — **do not change them**.
- Make the display read-only: `boot_state` already returns `balances` (including `shard_accrued_usdt`, `last_accrual_at`). Add `server_now` to the payload and compute on the client:

```
pending = shard_accrued_usdt + (server_now_adjusted - last_accrual_at) * perSec
```

`perSec` is already computed in `bootstrap` and matches the SQL formula (shards × 0.01 × rate × (1+boost) + active principal × rate, per day ÷ 86400). The daily budget cap is still enforced on the real accrual at collect time; the display may slightly overshoot when the cap is reached (`budgetReached` flag already exists).

- **OWNER DECISION (only if hot-row contention still shows in load test):** `promo_budget_days.used` is one global counter updated by every accrual. Options: (a) keep as is; (b) approximate cap — accrual doesn't touch the global row, a 1-minute cron sums usage and sets `budget_reached`, small overshoot possible; (c) sharded counters. Default = (a) after 4.2 removes the boot-time call.

### 4.3 One call for login + first screen data

Add SQL (reference):

```sql
create or replace function public.session_init(p_tg bigint, p_username text, p_name text, p_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_user jsonb;
begin
  v_uid := public.ensure_user(p_tg, p_username, p_name, p_ref);
  update users set last_seen_at = now()
   where id = v_uid and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  select to_jsonb(u) - 'flags' into v_user from users u where u.id = v_uid;
  if (v_user->>'banned')::boolean then raise exception 'AUTH'; end if;
  return jsonb_build_object('uid', v_uid, 'user', v_user, 'server_now', now(), 'boot', public.boot_state(v_uid));
end $$;
revoke all on function public.session_init(bigint,text,text,text) from public, anon, authenticated;
grant execute on function public.session_init(bigint,text,text,text) to service_role;
```

New server fn `init` = verify initData → `session_init` → sign token → return `{ token, boot }` together with the cached globals (settings, results30, tiers). The client seeds `["boot"]` and `["tiers"]` query cache from it, so the first screen needs **1 DB RPC + cached reads** instead of ~9 calls. Keep `bootstrap` for later refreshes. Keep `notifyInvite` only when `ref` was applied **and** the user was created now.

### 4.4 Replace loops and JS-side math with single SQL calls

| Today | New |
|---|---|
| `buyCrystal` loops up to 10 `buy_crystal` calls | `buy_crystals(p_user, p_tier, p_qty, p_req, p_pay)` — one RPC, same request ids `${req}-${i}` so idempotency is unchanged |
| `team()` pulls 500 referrals + 3 more queries, joins with `.find()` | `team_summary(p_user)` — one RPC, top 10 members + exact totals |
| `checkFreeWithdraw` pulls all deposits/withdrawals rows | move **into** `request_withdrawal`, under the balance row lock (fixes S2) |
| `crystalRecords` 2 queries | one RPC with a join + `limit 10` |
| `requireUser` does `select *` | select only needed columns |

```sql
create or replace function public.buy_crystals(p_user uuid, p_tier int, p_qty int, p_req text, p_pay text)
returns int language plpgsql security definer set search_path = public as $$
declare i int; bought int := 0;
begin
  p_qty := greatest(1, least(10, coalesce(p_qty, 1)));
  for i in 0..p_qty-1 loop
    begin
      perform public.buy_crystal(p_user, p_tier, p_req || '-' || i, p_pay);
      bought := bought + 1;
    exception when others then
      if bought = 0 then raise; end if;   -- first one failed: report the real error
      exit;                                -- later ones failed: keep what was bought (same as today)
    end;
  end loop;
  return bought;
end $$;
```

```sql
create or replace function public.team_summary(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
select jsonb_build_object(
  'members', coalesce((select jsonb_agg(m) from (
      select coalesce(nullif(u.name,''), u.username, 'Friend') as name,
             r.created_at as joined,
             exists(select 1 from crystals c where c.user_id = r.invited_id) as bought,
             r.valid, r.bonus_paid::numeric as bonus
        from referrals r join users u on u.id = r.invited_id
       where r.inviter_id = p_user order by r.created_at desc limit 10) m), '[]'::jsonb),
  'invited', (select count(*) from referrals where inviter_id = p_user and valid),
  'total',   coalesce((select sum(bonus_paid) from referrals where inviter_id = p_user), 0),
  'month',   coalesce((select sum(bonus_paid) from referrals where inviter_id = p_user
                        and created_at >= date_trunc('month', now())), 0));
$$;
```

Free-withdraw inside `request_withdrawal` (after `select … from balances … for update`): compute `deposited` (sum of credited `deposits.usd_value`), `friends` (count of `referrals` for inviter), `used` (sum of non-rejected/failed `withdrawals.amount`); if `deposited < 3` and `used + p_amount > ladder(friends)` → `raise exception 'FREE_WITHDRAW_LOCKED'`. Ladder (mirrors `FREE_LADDER`): ≥100→2.5, ≥75→1.5, ≥50→1.0, ≥35→0.6, ≥20→0.35, ≥10→0.15, ≥5→0.10, else 0. Keep the JS `freeAllowance()` for UI and add a test that JS and SQL agree.

Revoke/grant execute to `service_role` only for every new function (same pattern as `0002`).

### 4.5 Rate limiting: tiered, and clean up

| Action type | Limiter | Why |
|---|---|---|
| Money / one-shot: buy, withdraw, captcha, draw, collect, redeem, scan | keep DB `rate_hit` (exact) | Correctness matters, low volume |
| login, boot, reads, channel check | no DB limiter; isolate-memory soft limit (per uid, per isolate), and (Phase 1) shared limiter | Don't spend a DB write per read |

Cleanup (new cron route `/api/public/cron/cleanup`, same `authenticateCronRequest`, run hourly):

```sql
delete from rate_limits    where window_start < now() - interval '1 day';
delete from webhook_events where created_at   < now() - interval '3 days';
```

Add retention for `perk_history` / `crystal_settlements` / `ledger_entries` only if size becomes a problem (owner decision; never delete ledger without an archive).

### 4.6 Never lose a Telegram message; never block a request on one

- Replace bare `c.tgSend(...)`/`notifyUser(...)` calls with `fireAndForget(promise)`:
  - **VERIFY** whether `waitUntil` is reachable in server functions (nitro Cloudflare: `event.context.cloudflare.context.waitUntil`). If yes, use it. If not, `await` with `AbortSignal.timeout(1500)` for single-user notifications.
- Telegram webhook: return `200` quickly; heavy work (`ensure_user`, `sendPhoto`) via the same `fireAndForget`.
- Phase 1 replaces this with an outbox (5.3).

### 4.7 Turnstile off the critical path

- Today the client waits up to 2.5 s for Turnstile before `login`, but the server accepts a missing token, so it gives **no protection** (S7).
- Change: start login immediately without waiting; run Turnstile in the background after first render and send its token to a rate-limited `markHuman` call (stores `flags.cf_ok = true`).
- **OWNER DECISION:** keep it non-enforced (default, same as today's "never lock users out"). If the owner wants real protection, enforce Turnstile **only on withdrawals**, with the existing slide-puzzle captcha as fallback when the widget cannot load.

### 4.8 Input validation with zod (S3)

`zod` is already installed. Wrap every server function with a schema; reject before any DB call:

```ts
const Token = z.string().min(20).max(800);
const Req   = z.string().min(8).max(64);
const Amount = z.number().finite().positive().max(1_000_000);   // SQL still enforces min/max/daily limits
// buyCrystal:   { token: Token, tier: z.number().int().min(1).max(100), qty: z.number().int().min(1).max(10).optional(), req: Req }
// withdraw:     { token: Token, network: z.enum(["BEP20-USDT","GRAM-USDT"]), address: z.string().min(20).max(120), amount: Amount, req: Req, captcha: {...} }
// admin fns:    uuid / bigint-string / enum / max lengths on every free-text field (broadcast text ≤ 4096)
```

Return `{ ok:false, error:"ERROR" }` on schema failure. This also cuts DB load from garbage traffic.

### 4.9 Frontend speed and smoothness

| Item | What to do |
|---|---|
| Fonts | Self-host Manrope + Unbounded (woff2, `font-display: swap`, Latin subset; preload the body font). Remove the Google Fonts `<link>`s (render-blocking, slow/blocked in some regions) |
| First paint | Render `AppShell` + skeletons immediately; splash has a hard cap (≈1.5 s) after which skeleton shows; data arrive
