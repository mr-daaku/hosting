# CORE METHODS — Telegram Mini App (har bot me same method)

> Ye file "kya hoga" nahi, **"kaise hoga"** batati hai. Har bot/app me yehi methods follow hote hain. App-specific cheezein (tasks, plans, game) alag brief me aayengi.
>
> **Lovable ko bolo:** "Read CORE_METHODS.md. Implement every method M1–M14 exactly as written (code samples included). Where this file conflicts with any earlier prompt on these topics, this file wins. After building, deploy all edge functions and run the checklist in M15."

---

## M0. Common env / secrets (sab apps me same naam)

| Name | Kaha | Kaam |
|---|---|---|
| `BOT_TOKEN` | edge secret | initData verify + Bot API |
| `WEBHOOK_SECRET` | edge secret | Telegram webhook `secret_token` |
| `ADMIN_ID` | edge secret | **ek hi fixed admin** (tum) |
| `ADMIN_PIN_HASH`, `ADMIN_TOKEN_SECRET` | edge secret | admin 2nd factor + short session token |
| `HD_MNEMONIC` | edge secret (sirf address/sweep function) | deposit addresses derive |
| `HD_XPUB_EVM` | edge secret (optional, recommended) | mnemonic ke bina EVM address derive |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | edge secret | cache + rate limit + locks |
| `TONAPI_KEY`, `TONCENTER_API_KEY` | edge secret | chain scan |
| `PAYOUT_MNEMONIC` | edge secret (sirf payout worker) | hot wallet |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | frontend (public) | sirf ye frontend me |

Rule: koi bhi secret `VITE_` se start nahi hota.

---

## M1. System design (ek hi flow, sab apps me)

```
Telegram Mini App (React, static on Cloudflare CDN)
        │  har request: headers x-tg-init-data, x-device-fp
        ▼
Edge `api` (single gateway)
   1 verify initData  → 2 rate limit (Redis) → 3 cache read (Redis) → 4 DB RPC (1 round trip)
        │
        ├── writes: sirf Postgres RPC (atomic) → cache invalidate/write-through
        └── heavy/slow kaam: `jobs` queue

Telegram ──webhook──► Edge `bot-webhook` (secret_token, dedupe, ack 200 fast) ─► jobs
cron (30s) ─► deposit-scanner      cron (10s) ─► job-worker (notify, broadcast, payout)
```

Rules (M1.1–M1.6):
1. Frontend kabhi DB se seedha baat nahi karta. Sirf `api` gateway. Sab tables pe RLS ON + koi policy nahi (deny-all). Gateway service-role se kaam karta hai.
2. Har read endpoint = cache → miss pe 1 RPC. Har write endpoint = 1 RPC (ek transaction).
3. Request ke andar slow API (TonAPI, Telegram sendMessage, payout) call nahi. Queue me daalo.
4. Settings/config cache me; DB me sirf source of truth.
5. Balance/state sirf server pe. Client `localStorage` me sirf theme/language.
6. DB connection hamesha pooler (transaction mode, port 6543). Edge function chhote-lived hote hain, direct connection se "too many connections" aata hai.

---

## M2. Auth — sirf Telegram

**Proof ek hi hai: `initData` ka HMAC signature bot token se.** Baaki checks sirf extra hain.

### M2.1 Client

```ts
const tg = window.Telegram?.WebApp;
const initData = tg?.initData;                      // string, signed
if (!initData) { /* browser: sirf looping loading animation, userid 000000, koi real API call nahi */ }
const headers = { "x-tg-init-data": initData, "x-device-fp": await getFingerprint() };
```
Note: `initDataUnsafe` (parsed object) client-side hai aur badla ja sakta hai. Usse kuch bhi decide mat karo (is_bot, id, sab server pe verified initData se).

### M2.2 Server verify (har request, DB ke bina, microseconds)

```ts
// _shared/auth.ts
const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }

export async function verifyInitData(initData: string, botToken: string, maxAgeSec: number) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); if (!hash) throw new HttpError(401, "no_hash");
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (!safeEq(hex(await hmac(secret, dcs)), hash)) throw new HttpError(401, "bad_signature");
  const age = Math.floor(Date.now() / 1000) - Number(p.get("auth_date") ?? 0);
  if (!(age >= 0 && age <= maxAgeSec)) throw new HttpError(401, "expired");
  const user = JSON.parse(p.get("user") ?? "null");
  if (!user?.id) throw new HttpError(401, "no_user");
  return { user, startParam: p.get("start_param") as string | null };
}
```
> Builder note: Telegram ne naye `signature` field jode hain. Ye function tested library (`@telegram-apps/init-data-node` via `npm:` in Deno) ke saath **ek real initData pe test** karo. Library ho to wahi use karo, code upar sirf reference hai.

### M2.3 Gateway middleware

```ts
type Purpose = "read" | "money" | "admin";
const MAX_AGE: Record<Purpose, number> = { read: 86400, money: 3600, admin: 300 };

export async function authenticate(req: Request, purpose: Purpose) {
  const initData = req.headers.get("x-tg-init-data");
  const fp = req.headers.get("x-device-fp");
  if (!initData || !fp || fp.length < 16) throw new HttpError(401, "no_auth");        // fp mandatory
  const { user, startParam } = await verifyInitData(initData, Deno.env.get("BOT_TOKEN")!, MAX_AGE[purpose]);
  if (user.is_bot === true) throw new HttpError(403, "bot_account");                  // M3
  if (await isBanned(user.id, fp)) throw new HttpError(403, "banned");                // Redis cached
  return { user, startParam, fp };
}
```
Replay se bachne ke liye: money actions pe `auth_date ≤ 1h` + per-action `idempotency key` (M8) + rate limit (M5).

---

## M3. Account verification — bot account ko app me jane hi mat do

### M3.1 Sach kya hai (research ke baad)

- `is_bot` Telegram ke `WebAppUser` me **optional** field hai (docs: "True, if this user is a bot"). Check lagao, par ye akela kaafi nahi: bot accounts normally Mini App khol hi nahi sakte, isliye ye mostly `undefined/false` rahega.
- **Welcome message probe** achha signal hai: bot ko message bhejna Telegram me fail hota hai (`Forbidden: bot can't send messages to bots`), deactivated account pe `user is deactivated`.
- Lekin **sendMessage fail = fake user nahi**. `Forbidden: bot can't initiate conversation with a user` ka matlab user ne bot ko Start nahi kiya (real user bhi menu/link se app khol sakta hai). `bot was blocked by the user` bhi real user hota hai.
- Real farm accounts (insaan ke banaye, script se chalaye) ye sab checks pass karenge. Unke liye M3.4 ke gates hain.

### M3.2 Pipeline (first open pe, non-blocking)

```
verified initData ─► user.is_bot === true? ──yes──► reject 403
        │ no
        ▼
users row banao: verify_state='pending'   (referral abhi credit NAHI)
        │
        ▼
jobs.enqueue('welcome_probe', {user_id})   ← app turant khul jata hai
        │
        ▼ worker: sendMessage(chat_id=user_id, welcome text)
   ┌────────────────────┬─────────────────────────────────────────────┐
   │ result             │ action                                       │
   ├────────────────────┼─────────────────────────────────────────────┤
   │ ok                 │ verify_state='human', reachable=true         │
   │ "can't send messages to bots" │ 'bot' → ban, referral cancel      │
   │ "user is deactivated"         │ 'bot' (dead) → ban               │
   │ "bot was blocked by the user" │ 'blocked' (real, unreachable)    │
   │ "can't initiate conversation" │ 'unreachable' → soft gate (M3.3) │
   │ 429                │ retry_after ke baad dobara                   │
   └────────────────────┴─────────────────────────────────────────────┘
```

```ts
// worker: classify Telegram error
function classify(res: { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } }) {
  if (res.ok) return "human";
  const d = (res.description ?? "").toLowerCase();
  if (res.error_code === 429) return "retry";
  if (d.includes("can't send messages to bots")) return "bot";
  if (d.includes("user is deactivated")) return "bot";
  if (d.includes("blocked by the user")) return "blocked";
  if (d.includes("can't initiate conversation")) return "unreachable";
  return "unreachable";            // unknown 403/400 → soft gate, ban nahi
}
```
Error strings Telegram ka official contract nahi hain; isliye unknown case me ban nahi, soft gate.

### M3.3 Unreachable user ko reachable banane ka method

1. `initData.user.allows_write_to_pm === true` ho to bot message kar sakta hai (user ne write access diya).
2. Nahi ho to app ek baar `Telegram.WebApp.requestWriteAccess()` maange, success pe probe dobara queue karo.
3. Fallback: "Start bot" button (`https://t.me/{BOT}?start=verify`). `/start` webhook pe aate hi `chat_started=true`, `verify_state='human'`.
4. Jab tak `human` nahi: app chalega, par **referral reward, withdrawal, ad/ task rewards ka high-value part gated** (M3.4).

### M3.4 Referral + money gates (sab apps me)

| Event | Rule |
|---|---|
| Referral link se aaya | `referrer_id` save karo par reward tabhi jab referred user `verify_state='human'` **aur** app ki condition poori ho (e.g. 1 task) |
| `verify_state='bot'` | referrer ko kuch nahi, referred user ban, referral row `cancelled` |
| Self referral / same device_fp / same IP-hash | no reward, flag |
| First withdrawal | `human` + account age ≥ N hours (apne DB ke `created_at` se; Telegram account age initData me nahi aati) |
| Same `device_fp` pe >1 account | auto-flag, withdraw hold, admin review |
| Webhook `my_chat_member` (user ne bot block kiya) | `reachable=false` set karo (free signal) |

Soft heuristic (optional): Telegram user IDs time ke saath badhte hain, to bahut naya ID + naya device + turant referral = high risk score. Ye sirf score badhaye, akela ban ka reason nahi.

---

## M4. Admin auth — ek fixed admin (sirf tum)

Rules:
1. Admin = `user.id === Number(ADMIN_ID)` (env). **Koi `admins` table nahi, "Make admin" feature nahi, UI se admin add/remove nahi.** (Purane prompts me Make/Remove Admin tha, wo hata do.)
2. Admin API alag edge function `admin-api` me (chhoti surface). Har call: `authenticate(req,"admin")` (initData `auth_date ≤ 5 min`) + id match + admin token.
3. Second factor: PIN. Server `ADMIN_PIN_HASH` se compare karta hai, phir 30-min ka signed token deta hai (admin id + device fp bound).
4. PIN attempts: 5 galat → 15 min lock (Redis).
5. Hidden entry: app me koi admin button nahi; sirf admin id ke liye secret route/long-press, aur server har request me phir check karta hai (UI hide = security nahi).
6. Sensitive actions (deposit address badalna, payout limit badalna, bade payout approve, mass broadcast) pe PIN dobara maango.
7. Naya device_fp se admin login hone pe bot DM alert.
8. Audit log (capped, 90 din) sab admin actions ka.

```ts
// admin token (HMAC, stateless)
export async function signAdminToken(fp: string, ttlSec = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${Deno.env.get("ADMIN_ID")}.${fp}.${exp}`;
  const sig = hex(await hmac(enc.encode(Deno.env.get("ADMIN_TOKEN_SECRET")!), body));
  return `${body}.${sig}`;
}
export async function verifyAdminToken(token: string, fp: string) {
  const [id, tfp, exp, sig] = token.split(".");
  const body = `${id}.${tfp}.${exp}`;
  const ok = safeEq(hex(await hmac(enc.encode(Deno.env.get("ADMIN_TOKEN_SECRET")!), body)), sig);
  if (!ok || tfp !== fp || Number(exp) < Date.now() / 1000 || id !== Deno.env.get("ADMIN_ID")) throw new HttpError(403, "admin_denied");
}
```
PIN hash: salted slow hash (argon2/scrypt via library) ya kam se kam `PBKDF2` WebCrypto; plain PIN kahin nahi.

---

## M5. Rate limit (3 layer)

| Layer | Kaha | Limit (default) |
|---|---|---|
| L1 | Cloudflare WAF rate rule `/functions/*` | 120 req / 10s per IP |
| L2 | Gateway, Redis, per user id | 30 req / 10s |
| L3 | Action-specific (Redis) | claim/spin: 1/s + 5/min · check-deposit: 1/10s · withdraw: 3/hour · signup per device: 3/day · admin PIN: 5/15 min |

```ts
// fixed window, 1 round trip (Upstash REST pipeline)
export async function hit(key: string, limit: number, windowSec: number, failOpen = true) {
  try {
    const r = await fetch(`${Deno.env.get("UPSTASH_REDIS_REST_URL")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("UPSTASH_REDIS_REST_TOKEN")}` },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, windowSec, "NX"]]),   // EXPIRE NX: Redis 7+
    });
    const [incr] = await r.json();
    return incr.result <= limit;
  } catch { return failOpen; }            // reads: fail-open · money actions: failOpen=false
}
```
- Over limit → HTTP 429 + `retry_after` seconds; UI cooldown timer dikhata hai.
- Redis down ho to read endpoints chalein (fail-open), money endpoints band (fail-closed).
- Fallback (Redis nahi): Postgres `rate_hit(key, limit, window)` function (upsert-based counter). Scale pe Redis.

---

## M6. Database pe load kam — patterns

1. **Bootstrap RPC**: app open pe ek hi call (user + balances + counters). 6 alag queries nahi.
2. **Settings cache** (M7) — DB se har request me nahi.
3. **Counters, COUNT(*) nahi**: totals (users, deposits, pending withdrawals) ek `stats` table me, usi transaction me `+1`. Dashboard `COUNT(*)` bade table pe nahi.
4. **Leaderboard**: cron har 60s top-100 compute karke Redis me daalta hai. User request me `ORDER BY ... LIMIT` nahi.
5. **Write kam**: `last_seen_at` max 5 min me ek baar (Redis flag se check). Har request pe log insert nahi. Sirf paisa/state badalne wale events likho.
6. **Retention cron**: `ad_views`, `audit_log`, `rate_limits`, processed `jobs`, ignored deposits ko 7-90 din baad delete (daily cron, batch delete).
7. **Narrow rows**: `smallint/int` status codes, `numeric` sirf paisa ke liye, hot tables me jsonb blob nahi.
8. **Derived data store mat karo**: deposit address, referral link, display strings compute karo (address ke liye M12).
9. **Upsert**: `insert ... on conflict do nothing/update` use karo, `select` phir `insert` nahi.
10. **Keyset pagination** (`where id < $last order by id desc limit 20`), `OFFSET` nahi.
11. **Realtime sirf jaha zaruri** (live admin queue). User ke liye smart polling (focus pe refetch, 5-15s backoff).
12. **Heavy analytics** read-replica ya rollup table (cron 1-5 min) se.

```sql
-- (3) counters same tx me
create table stats (key text primary key, value bigint not null default 0);
-- RPC ke andar: insert ... ; update stats set value = value + 1 where key = 'users_total';

-- (1) bootstrap: ek round trip
create or replace function public.bootstrap(p_user bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user',     (select to_jsonb(u) - 'device_fp' - 'ip_hash' from users u where u.id = p_user),
    'balances', coalesce((select jsonb_object_agg(currency, amount) from balances where user_id = p_user), '{}'::jsonb)
  );
$$;
revoke all on function public.bootstrap(bigint) from public, anon, authenticated;
```

---

## M7. Caching

### M7.1 Layers

| Layer | Data | TTL | Invalidate |
|---|---|---|---|
| Cloudflare CDN | JS/CSS/images (hashed names) | 1 saal | naya deploy = naya hash |
| L1 in-function memory | settings, ban-set, assets whitelist | 10-30s | TTL |
| L2 Redis | settings, task list, leaderboard, prices, whitelist | 15-120s | admin write pe `DEL` |
| Client TanStack Query | profile, lists | staleTime 15-60s | mutation ke baad `invalidate` |

**Balance**: cache me mat rakho jab tak write-through na ho. Write ke baad naya balance RPC se aata hai (RETURNING) aur client cache usi se update hota hai.

### M7.2 Helper (stampede-safe)

```ts
const mem = new Map<string, { v: unknown; exp: number }>();

export async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  const m = mem.get(key); if (m && m.exp > Date.now()) return m.v as T;               // L1
  const hit = await redisGet(key); if (hit != null) { mem.set(key, { v: hit, exp: Date.now() + 10_000 }); return hit as T; }   // L2
  const got = await redisSetNX(`lock:${key}`, 1, 10);                                  // ek hi request DB jaaye
  if (!got) { await sleep(150); const again = await redisGet(key); if (again != null) return again as T; }
  const v = await load();
  await redisSet(key, v, ttlSec);
  mem.set(key, { v, exp: Date.now() + 10_000 });
  return v;
}
```
Key naming: `s:{app}:settings`, `s:{app}:tasks:v{n}`, `s:{app}:lb:balance`, `u:{id}:profile`. Version bump (`v{n}`) se bulk invalidate.

---

## M8. DB read/write speed

**Writes**
1. Har paisa-wala write = ek RPC (`plpgsql`), ek transaction, ek round trip. App code me multi-step transaction nahi.
2. Balance sirf `adjust_balance` se; `ledger.unique(reason, ref)` = idempotency.
3. Row lock sirf zaruri row pe (`for update` user ke balance row pe), transaction chhoti.
4. Batch insert: `insert ... select unnest($1::bigint[])` (notifications, broadcast rows).
5. Non-critical write (analytics, notification log) queue se, request ke baad.

```sql
create or replace function public.adjust_balance(p_user bigint, p_currency text, p_amount numeric, p_reason text, p_ref text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_new numeric;
begin
  insert into ledger (user_id, currency, amount, reason, ref) values (p_user, p_currency, p_amount, p_reason, p_ref);  -- unique(reason,ref) → duplicate = unique_violation
  insert into balances (user_id, currency, amount) values (p_user, p_currency, 0) on conflict do nothing;
  update balances set amount = amount + p_amount, updated_at = now()
   where user_id = p_user and currency = p_currency and amount + p_amount >= 0 returning amount into v_new;
  if not found then raise exception 'insufficient_funds'; end if;   -- ledger insert bhi rollback
  return v_new;
end $$;
revoke all on function public.adjust_balance(bigint,text,numeric,text,text) from public, anon, authenticated;
```
`unique_violation` ko error nahi, "already processed" maano. `ref` deterministic ho: `deposit:{tx}`, `withdraw:{id}`, `task:{id}:{user}`, `daily:{key}:{utc_date}`.

**Reads**
1. Index: har `WHERE`/`ORDER BY`/FK column. Hot filter ke liye partial index (`where status='pending'`).
2. Composite index order = filter columns pehle, sort column last.
3. `select` me sirf zaruri columns.
4. N+1 nahi; join ya RPC me jodo.
5. Naya query ship karne se pehle `EXPLAIN (ANALYZE, BUFFERS)`; seq scan on big table = reject.
6. DB settings: `statement_timeout` (e.g. 5s), `idle_in_transaction_session_timeout` (e.g. 10s).
7. Jab table 50M+ rows ho: date partition (`ledger`) + purani partition archive.

```sql
create index on withdrawals (status, created_at) where status in ('pending','queued','sending');
create index on ledger (user_id, id desc);
```

---

## M9. Telegram webhook

**Setup (ek baar, deploy script me):**
```
POST https://api.telegram.org/bot{BOT_TOKEN}/setWebhook
{ "url": "https://{project}.functions.supabase.co/bot-webhook",
  "secret_token": "{WEBHOOK_SECRET}",
  "allowed_updates": ["message","callback_query","my_chat_member"],
  "max_connections": 40, "drop_pending_updates": true }
```

**Handler rules:** secret check → dedupe `update_id` → turant 200 → kaam background me. (Non-2xx pe Telegram dobara bhejta hai, to errors andar handle karo, 200 hi do.)

```ts
Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== Deno.env.get("WEBHOOK_SECRET")) return new Response("no", { status: 401 });
  const update = await req.json();
  if (!(await redisSetNX(`upd:${update.update_id}`, 1, 3600))) return new Response("ok");   // duplicate update ignore
  // @ts-ignore Supabase runtime
  EdgeRuntime.waitUntil(handleUpdate(update).catch(console.error));
  return new Response("ok");
});
```
Is function pe JWT verify OFF (Telegram JWT nahi bhejta); security = `secret_token`.

**`/start` handler (fast path, 1 DB call):**
1. `upsert user` (id, name, username) + `chat_started=true` + referral param (`startapp`/`/start {id}`, self-referral reject, sirf pehli baar set).
2. Welcome reply: media **ek baar upload karke `file_id` Redis/settings me cache** karo, baad me `file_id` se bhejo (re-upload slow hota hai). Text chhota, buttons max 3.
3. Heavy kuch nahi (verify probe, notifications → queue).

**`my_chat_member`**: `new_chat_member.status = kicked/left` → `reachable=false`; `member` → `reachable=true`.

**Outgoing send helper (sab bot messages isi se):**
```ts
export async function tgSend(method: string, body: object) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.telegram.org/bot${Deno.env.get("BOT_TOKEN")}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok || j.error_code !== 429) return j;
    await sleep((j.parameters?.retry_after ?? 1) * 1000 + 100);    // 429: retry_after ka sammaan
  }
  return { ok: false, error_code: 429 };
}
```
Telegram limits: ek chat me ~1 msg/sec, bulk ~30 msg/sec (upar 429). Paid broadcast BotFather me on karo to ~1000 msg/sec (free 30 se upar har msg ka Stars cost).

---

## M10. Queue + Auto-pay

### M10.1 Generic queue (notifications, broadcast, probe, payout)

```sql
create or replace function public.claim_jobs(p_type text, p_limit int) returns setof jobs
language sql security definer set search_path = public as $$
  update jobs set status = 'running', attempts = attempts + 1, locked_at = now()
  where id in (select id from jobs where type = p_type and status = 'queued' and run_at <= now()
               order by id for update skip locked limit p_limit)
  returning *;
$$;
revoke all on function public.claim_jobs(text,int) from public, anon, authenticated;
```
Worker (cron har 10s): `claim → process → done` ya `failed + run_at = now() + backoff`. Backoff: 10s, 30s, 2m, 10m, phir `needs_review` + admin DM. Stuck `running` (locked_at > 5 min) wapas `queued` (cron recovery).
Rates: notifications/broadcast ≤ 25-30 msg/sec; payout concurrency = **1**.

### M10.2 Auto-pay (queued payout)

State machine:
```
pending ─(auto rule pass)─► queued ─► sending ─► sent ─► paid
   │                           │          │
   └─(admin approve)───────────┘          └─(unknown/timeout)─► needs_review
admin reject ─► rejected (+ optional refund)
```
**Auto rule** (settings me): `amount ≤ auto_limit` AND `verify_state='human'` AND age ok AND not flagged AND address valid. Warna admin approve queue me.

**Double-pay se bachne ka method (sabse zaruri):**
1. Payout se pehle row me `attempt_id`, `valid_until` (e.g. now+120s) save karo, status=`sending` — **phir** chain pe bhejo.
2. Transfer comment/memo me withdrawal id daalo (`WD-{id}`).
3. Retry se pehle chain/provider pe check: outgoing tx with `WD-{id}` mili? → `paid` mark karo, retry nahi.
4. Nahi mili aur `valid_until` nikal gaya (TON wallet message expire ho jata hai) → tabhi naya attempt safe.
5. Timeout/unknown me blind retry kabhi nahi → `needs_review`.

**Single-flight** (ek time pe ek payout, pooler-safe lease row; session advisory lock transaction pooling me bharosemand nahi):
```sql
create table locks (name text primary key, until timestamptz not null);
-- acquire (returns row if won)
insert into locks(name, until) values ('payout_ton', now() + interval '60 seconds')
on conflict (name) do update set until = excluded.until where locks.until < now()
returning name;
```
Extra: hot wallet me chhota float, daily payout cap, 429 pe backoff + provider fallback, user ko "processing" dikhao (provider ka "network busy" nahi), paid hone pe DM + payment-channel post.

---

## M11. Fake token / unwanted deposit — ignore method

**Scanner = ek central cron.** Per-user API call nahi (429 isi se aata hai).

```
cron 30s → cursor (last_lt / block) se naye incoming txs fetch (API key, backoff, 2 provider fallback)
 → har tx classify:
    native?            → memo regex match → credit
    token?             → contract (raw address) assets whitelist me? → haan: memo match → credit
                                                               → nahi: IGNORE (credit nahi, DB row nahi)
    outgoing / dust / no memo → IGNORE
 → cursor aage badhao (credit ke saath hi, ek transaction)
```

Rules:
1. **Whitelist `assets(chain, address_raw, symbol, decimals, min_amount, enabled)`**. Naya coin sirf contract address ke saath add hota hai. Symbol/name pe kabhi trust nahi (same symbol ka fake token common hai).
2. **Address compare raw form me**: TON `Address.parse(x).toRawString()`, EVM `lowercase`. Friendly/bounce forms alag dikhte hain, string compare galat hoga.
3. Decimals/min amount whitelist se lo, token ke metadata se nahi.
4. Credit tabhi jab: `to == our address` + incoming + asset whitelisted + memo regex `^{PREFIX}-(\d+)$` + user exist + `amount ≥ min`.
5. **Ignored = DB me save nahi** (DB load kam). Sirf Redis counter `ign:{day}:{reason}` badhao. Exception: *real whitelisted asset + valid user + below_min/galat-memo* ho to `deposit_review` me daalo (7 din TTL) taaki tum manually credit kar sako.
6. Idempotency: `deposits.unique(chain, tx_hash)` + `adjust_balance(... 'deposit', tx_hash)`.
7. High value pe provider ke decoded `jetton_master` ko doosre provider se cross-check.

```ts
// TON jetton credit decision
const master = Address.parse(t.jetton_master).toRawString();
const asset = (await assetsWhitelist()).get(`ton:${master}`);       // cached M7
if (!asset || !asset.enabled) return ignore("unlisted_token");
const m = /^PREFIX-(\d+)$/.exec(t.comment ?? "");
if (!m) return asset ? review("no_memo") : ignore("no_memo");
const amount = Number(t.amount) / 10 ** asset.decimals;
if (amount < asset.min_amount) return review("below_min");
await db.rpc("credit_deposit", { p_user: Number(m[1]), p_chain: "ton", p_asset: asset.symbol, p_amount: amount, p_tx: t.tx_hash });
```

---

## M12. Deposit address generation — DB me sirf index

**Kya save hota hai:** `users.wallet_index int unique` (sequence se, **lazy**: pehli baar deposit page khulne pe). Address, QR, private key DB me **kabhi nahi**.

```sql
create sequence wallet_index_seq start 1;
alter table users add column wallet_index int unique;
-- assign: update users set wallet_index = nextval('wallet_index_seq') where id = $1 and wallet_index is null returning wallet_index;
```

### M12.1 Chain-wise derive method

| Chain | Method | Path / note |
|---|---|---|
| EVM (ETH, BSC, Arbitrum, Base) | HD secp256k1 | `m/44'/60'/0'/0/{index}` |
| Tron | same secp256k1, Tron address format | `m/44'/195'/0'/0/{index}` → base58check(0x41 + last 20 bytes) |
| Solana | SLIP-0010 ed25519 (sab hardened) | `m/44'/501'/{index}'/0'` |
| TON | **default: ek shared address + memo `{PREFIX}-{id}`** (derive nahi, sabse sasta) | optional: same key, alag `walletId/subwalletId` per index (V4/V5 wallets support karte hain; address badalta hai, deploy+sweep ka kharcha) |

```ts
// EVM — recommended: mnemonic server pe nahi, sirf account-level xpub
// one-time offline: HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'").neuter().extendedKey → HD_XPUB_EVM env
import { HDNodeWallet } from "ethers";
export function evmAddress(index: number) {
  const node = HDNodeWallet.fromExtendedKey(Deno.env.get("HD_XPUB_EVM")!);   // xpub = non-hardened children possible
  return node.deriveChild(0).deriveChild(index).address;
}
// (simple version, mnemonic env me): HDNodeWallet.fromPhrase(HD_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).address

// Solana — mnemonic chahiye (hardened)
import { mnemonicToSeedSync } from "bip39"; import { derivePath } from "ed25519-hd-key"; import { Keypair } from "@solana/web3.js";
export function solAddress(index: number) {
  const seed = mnemonicToSeedSync(Deno.env.get("HD_MNEMONIC")!).toString("hex");
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed);
  return Keypair.fromSeed(key).publicKey.toBase58();
}
```

### M12.2 Serve method (DB-free, fast)

1. `GET /deposit-address?chain=bsc` → `index` DB se (ya assign) → `cached("addr:bsc:{index}", forever, () => derive(index))` (Redis, deterministic, kho jaye to dobara ban jata hai).
2. Derive code sirf ek chhote function `address-service` me; secret sirf wahi function padhta hai; logs me kabhi nahi.
3. Frontend ko sirf address + QR (client-side generate) milta hai.

### M12.3 Detect (EVM/Tron/Sol) bina DB bhare

- **Watch-set**: jis user ne deposit page khola uska `index` Redis set `watch:{chain}` me 30 min ke liye (TTL). Scanner in addresses ko jaldi-jaldi (10-20s) check karta hai; purane depositors ko 5-10 min me.
- ERC20: `eth_getLogs` Transfer topic + `to` list (batch me) + contract whitelist; native: provider ka address-tx API.
- Bahut zyada addresses (50k+) pe provider ka address-activity webhook behtar hai (paid).
- Credit hone ke baad `sweep` job (queue): user address → main wallet, gas top-up ke saath.

### M12.4 Security

- `HD_MNEMONIC`/`HD_XPUB_EVM` sirf env secret, repo/log/chat me kabhi nahi.
- Mnemonic leak = sab address ka paisa. Isliye: deposit addresses me balance rukne mat do (jaldi sweep), mnemonic sirf sweep/solana function ko, EVM ke liye xpub use karo.
- `wallet_index` user ko expose mat karo.

---

## M13. UI — buttons, empty/error states

### M13.1 Har action button (global component, har jagah yehi)

```tsx
// components/ActionButton.tsx
import { useRef, useState } from "react";
export function ActionButton({ onAction, children, disabled, className = "" }:
  { onAction: () => Promise<unknown>; children: React.ReactNode; disabled?: boolean; className?: string }) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);                       // render se pehle double-tap bhi roke
  const run = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    try { await onAction(); }
    finally { lock.current = false; setBusy(false); }   // response ke baad enable
  };
  return (
    <button onClick={run} disabled={busy || disabled} aria-busy={busy}
      className={`inline-flex items-center justify-center gap-2 ${busy ? "cursor-progress opacity-80" : ""} disabled:cursor-not-allowed ${className}`}
      style={busy ? { cursor: "progress" } : undefined}>
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      <span>{children}</span>
    </button>
  );
}
```
Rule: app me koi bhi `<button onClick={asyncFn}>` seedha nahi, sirf `ActionButton`. Mutations par auto-retry **nahi** (paisa). Gateway idempotency key bhi lagao: client har click pe `crypto.randomUUID()` bhejta hai (`x-idem-key`), server `ref` me use karta hai.

### M13.2 Query states (loading → skeleton, error → retry, empty → CTA)

```tsx
export function QueryState<T>({ q, skeleton, empty, isEmpty, children }:
  { q: UseQueryResult<T>; skeleton: React.ReactNode; empty: React.ReactNode; isEmpty?: (d: T) => boolean; children: (d: T) => React.ReactNode }) {
  if (q.isPending) return <>{skeleton}</>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (isEmpty?.(q.data)) return <>{empty}</>;
  return <>{children(q.data)}</>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => Promise<unknown> | void }) {
  const e = error as { status?: number; retryAfter?: number };
  const msg = e.status === 429 ? `Too many requests. Try again in ${e.retryAfter ?? 5}s`
    : e.status === 401 ? "Please open this app from Telegram"
    : !navigator.onLine ? "No internet connection"
    : "Something went wrong";
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <ErrorIcon /><p>{msg}</p>
      <ActionButton onAction={async () => { await onRetry(); }}>Retry</ActionButton>
    </div>
  );
}
```
- **Empty state**: icon + 1 line + CTA (e.g. "No tasks yet" → "Refresh"). Kabhi blank screen nahi.
- Error mapping: 401 → Telegram me kholo, 403 banned → clear message, 429 → countdown, 5xx/network → Retry.
- Global `ErrorBoundary` + offline banner.
- Query defaults: GET `retry: 2` (exponential), mutations `retry: false`.

---

## M14. Smooth UX (speed feel)

1. Telegram init: `ready()`, `expand()`, fullscreen (`requestFullscreen()` jaha supported), safe-area insets (top/bottom). Bottom nav fixed, content top safe-area ke neeche.
2. First paint < 2s: route-level `lazy()`, TonConnect/charts lazy, images WebP + width/height (layout shift nahi), icons SVG.
3. Skeletons har list/card pe; spinner sirf button me.
4. Optimistic UI: claim/spin/task button pe turant update, fail pe rollback + toast. Balance server response se final.
5. Prefetch: nav tab pe hover/focus par next route data `prefetchQuery`.
6. TanStack Query: `staleTime` 15-60s, `placeholderData: keepPreviousData`, focus pe refetch.
7. Numbers: balance box font auto-shrink (`clamp`), decimals max 6, overflow nahi.
8. Haptics: tap (light), success, error. Toasts brand-styled.
9. Animations 150-250ms, `prefers-reduced-motion` respect.
10. Browser guard: Telegram ke bahar sirf looping loader.

---

## M15. Common checklist (har bot ship karne se pehle)

- [ ] Har table RLS ON, koi policy nahi; frontend bundle me koi secret nahi (`grep BOT_TOKEN|MNEMONIC|SERVICE`)
- [ ] initData signature fail/expired/no-fp → 401; `is_bot` → 403
- [ ] Do alag Telegram accounts: state isolated
- [ ] Double-tap / same request 2x → balance 1 hi baar badla
- [ ] Naya user: app turant khula, welcome probe job chala, `verify_state` set hua; bot-case simulate (error mapping)
- [ ] Referral: `human` + condition ke baad hi reward; `bot` pe cancel
- [ ] Admin: non-admin har admin endpoint pe 403; PIN 5 galat = lock; koi "add admin" feature nahi
- [ ] Rate limit: limit cross pe 429 + UI countdown; Redis down pe read chale, money band
- [ ] Webhook: galat secret 401; duplicate update_id ek baar process; response < 1s
- [ ] Deposit: whitelisted token credit; fake same-symbol token ignore; no-memo ignore; duplicate scan duplicate credit nahi; ignored rows DB me nahi
- [ ] Address: same index → same address (deterministic), DB me address column nahi
- [ ] Auto-pay: concurrency 1, `WD-{id}` check ke baad hi retry, stuck job recovery
- [ ] Har async button `ActionButton`; loading me disabled + spinner + progress cursor
- [ ] Har list: skeleton, empty, error+retry
- [ ] `EXPLAIN` me hot queries index use karti hain; bootstrap = 1 RPC
- [ ] Edge functions deploy ho gaye; build/lint/type-check clean

---

## M16. App brief template (is file ke saath har app me ye paste karo)

```
APP: {name}  BOT: @{bot}  SHORTNAME: {shortname}  MEMO_PREFIX: {prefix}
CHAINS/ASSETS: (whitelist with contract addresses)
CURRENCIES & RATES:
FEATURES (app-specific): (tasks / plans / mining / game ...)
BOTTOM NAV:
BRAND: color, logo, welcome media URL, exact /start text
DEFAULT SETTINGS: (min deposit, min withdraw, fee, auto_limit, rewards)
EXTRA RULES: (e.g. no emoji, SVG only)
```
