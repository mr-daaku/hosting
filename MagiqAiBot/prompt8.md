# MagiqAi — Prompt 8

> Read this whole file first and do **everything in one pass**. Never ask me to type "start" or "continue".
> A "TS2686 use-mobile" error that carries a prompt link/word is not a real error — ignore it.
> Before touching money / auth / admin code, re-read `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/security.md` and `AGENTS.md` + `src/lib/AGENTS.md`.
> Every new user-facing label goes into all 4 locales (en, ru, zh, ar) in `src/lib/i18n.ts`.
> Naming: the coin is **GRAM** everywhere the user can see it. Internal chain key `"ton"`, env names (`TON_API_KEY`, `TONAPI_KEY`, `TON_PAY_*`), API hosts and `@ton/*` packages stay as they are.
> **You have internet access: whenever something is unclear or a fix does not work, SEARCH the web** (Lovable docs, Supabase/Postgres docs, TonCenter and TonAPI docs, Telegram Bot API docs, Tether/Circle docs, bscscan/etherscan) and use what you find. Mention in the final report which source solved which problem.
> **Never write "tested" or "verified" for something you did not actually run.** Say plainly what was real, what was mocked and what you could not do.

## 0. Task list and order

Do them in this order (the app must open first, then money, then features):

| # | Task | Priority |
|---|------|----------|
| 1 | App does not open — stuck on "connecting to the magic library": diagnose database + backend, fix, reset DB only if needed | 🔴 first |
| 2 | GRAM / GRAM-USDT autopay shows "retry in 300 s" even with TonCenter + TonAPI keys: find the real error, deploy, pay the pending test withdrawals | 🔴 |
| 3 | Fake coins: verify by official contract address, never credit fakes, tag `fake`, save to DB, admin review | 🔴 |
| 4 | Referral stays pending until the friend buys ≥1 character AND completes ≥1 task | 🟠 |
| 5 | Withdraw: strict address verification (wrong address = no withdrawal) | 🟠 |
| 6 | `/health` command (+ safe mode) for admins | 🟠 |
| 7 | @MagiqAdvBot: "My Tasks" with full status, rate limits, caching | 🟠 |
| 8 | Docs, migration, tests, final verification | mandatory |

---

## 1. TASK 1 — App will not open ("contacting the magic library")

### 1.1 What the code does today (already read, do not rediscover)
* `MagiqApp.tsx` boot: `Promise.allSettled([getConfig(), getMe(), checkJoin()])` and the loading screen stays until **all three** settle. There is **no timeout anywhere**. The text "connecting…" only appears after 6 s; after that the user is stuck forever if any one call hangs.
* `getMe` does: `rateLimit` (DB RPC) → `game_boot` (DB RPC, may create the player and advance `wallet_counter` under an advisory lock) → background `tickSoon()`.
* `getConfig` → `buildConfig` awaits `getSettings()` (DB), `getCharacters()` (DB) and `prices()` (up to several external HTTP calls) before it answers. On a cold isolate the first user waits for all of it.
* `checkJoin` calls Telegram `getChatMember` per required channel.
* The Supabase admin client has **no request timeout**, so a stuck database = a stuck page.
* `tickSoon()` (autopay drain + awaiting-price retry) is triggered by `getMe` and `getConfig`. If the payout path or `payout_lock` misbehaves, background work piles up.

### 1.2 Step A — Diagnose the database and backend (do this first, report the numbers)
Run these against the live backend and report results in the final answer:
1. `select 1` latency (5 samples) and latency of `me_json`, `game_boot` (use a throw-away test user id), `rate_hit`, `app_settings` select.
2. `pg_stat_activity`: connections vs `max_connections`, sessions `idle in transaction`, longest running query, queries waiting on locks; `pg_locks` blocking chains; any lock held on `rate_limits`, `wallet_counter`, `payout_lock`, `app_settings`.
3. Table sizes / dead tuples for `rate_limits`, `ledger`, `deposits`, `request_keys`, `players`; check that every index from the migrations exists. If `rate_limits` or `request_keys` grew without cleanup, add a cleanup (delete rows older than 1 day, run from the cron tick).
4. Check that **all** migrations `0000 … 0008` are really applied on the live database (list functions and columns: `defer_withdrawal`, `payout_lock_take`, `payout_lock_release`, `credit_awaiting_price`, `withdrawals.msg_hash/auto_pay/retry_count/next_retry_at/needs_review/last_error`, `adv_chat_state`). A missing function makes calls fail or hang in odd ways.
5. Check the backend status (Lovable Cloud / Supabase project: paused, restarting, out of resources, rate limited). Search the web for the exact symptoms you find.
6. Check that the deployed server really has the env vars (names only, never values): `BOT_TOKEN, ADV_BOT_TOKEN, TG_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INDEX_SECRET_WALLET, PAY_BSC_WALLET, TON_PAY_WALLET_SECRET, TON_PAY_ADDRESS, NODEREAL_API, TON_API_KEY, TONAPI_KEY, ADMIN_TG_ID, LOVABLE_CRON_SECRET`.

### 1.3 Step B — Fix the cause you found
Typical fixes: kill blocked/idle sessions, add `statement_timeout` / `idle_in_transaction_session_timeout` for the service role, add missing indexes, apply missing migrations, clean hot tables. Do the cheapest fix that works.

### 1.4 Step C — Make the app impossible to hang (do this regardless of the cause)
* **Timeouts everywhere on the server**: every Supabase call and every outbound `fetch` ≤ 8 s (use a `withTimeout()` helper and, for Supabase, a custom `fetch` with `AbortController` in a *new* wrapper inside `core.server.ts`; do **not** edit the auto-generated `src/integrations/supabase/client.server.ts`). Each server function has an overall deadline of 10 s and returns a clear error instead of hanging.
* **`getConfig` must never wait for outside APIs**: read settings/characters (cached) and use only the cached/stale price (`peek`), refresh prices in the background. First paint must not depend on any price API.
* **`getMe` stays DB-only and minimal** (`game_boot` only); keep the rate limit in memory for this read path.
* **Remove `tickSoon()` from `getMe` and `getConfig`.** The tick runs from the cron route only (set a scheduler: see 2.7). Each tick has a hard 20 s deadline and cannot overlap itself.
* **Client boot**: show the app as soon as `getMe` is ready; use the config saved in `sessionStorage` immediately (stale-while-revalidate); `getConfig` and prices fill in later. The required-channel gate keeps the owner rule (app never mounts behind it) but waits **at most 4 s**; on timeout fail open and re-check in the background, then show the full-screen gate if a channel is missing.
* If boot is still not done after **8 s**: replace the endless spinner with a message + the real reason (timeout / server error) and a **Retry** button; auto-retry twice with backoff. Never show an infinite loading screen.
* Add a tiny public `GET /api/public/health` route (no secrets, no user data): `200 {"ok":true,"db_ms":N}` or `503`. Useful for uptime monitors and for you to test.

### 1.5 Step D — Database reset (allowed, but only under these rules)
I allow a **full reset of the database only if** Steps A–C show the database is broken and cannot be repaired by cheaper means. There are no real users yet, so user data may be lost. But:
1. **Before any reset, finish Task 2** (settle/pay the pending withdrawals). Never reset while a withdrawal has `status='processing'` or a `msg_hash` whose on-chain result is unknown — that could be real money already sent.
2. **Back up the configuration first** (JSON in the chat/answer or a file): `app_settings`, `admins`, `character_config`, any rows in `tasks` that are not test data.
3. Re-apply **all** migrations `0000 … latest` in order, then restore the configuration from step 2. Make sure `ADMIN_TG_ID` still works.
4. **Do not let old blockchain deposits be credited a second time.** After a reset the dedupe table is empty and `wallet_index` restarts at 0, so a new user could receive an address that already holds old funds, and old transfers with an old memo would be treated as new. Required safeguards: (a) continue `wallet_counter` from `previous max(wallet_index) + 1` (or at least 1000); (b) save `deposit_min_ts` = reset time in `app_settings` and make **every** scanner (BSC, ETH, GRAM, ad payments) ignore transfers older than it.
5. After the reset: create a test user, check `game_boot`, deposit address generation, config load, admin panel, and report the numbers again.

---

## 2. TASK 2 — Autopay GRAM / GRAM-USDT: "retry in 300 seconds"

### 2.1 What the number means (confirmed in the code)
`RETRY_SECS = [30, 60, 120, 300, 600]` in `payout.server.ts`. "Retry in 300 s" means the withdrawal already failed **three times** (30 s, 60 s, 120 s) and this was the 4th failure. So it is not a one-off 429: something fails every time, and the real reason is saved in `withdrawals.last_error` but is not shown anywhere. **Do not guess — read it.**

### 2.2 Find the real error
1. Query every `withdrawals` row with `status in ('pending','processing')`: `id, user_id, chain, amount_usd, auto_pay, retry_count, next_retry_at, needs_review, msg_hash, last_error`. Report them (ids shortened).
2. Check the deployed server sees the keys: `tonProviderHealth()` must report `keyed: true` for **both** providers. If not, the running deployment does not have `TON_API_KEY` / `TONAPI_KEY` (secrets are only read by a new deployment) → deployment is stale → see 2.5.
3. Test each provider **with the key** from the deployed server and report only status codes: TonCenter v2 `getAddressInformation` and `runGetMethod seqno` for the payout wallet; TonCenter v3 `transactionsByMessage`; TonAPI `/v2/accounts/{payout}` and `/v2/accounts/{payout}/jettons/{USDT master}`. A `401/403` = wrong or wrong-type key (TonCenter and TonAPI keys are different services — make sure `TON_API_KEY` is the TonCenter key and `TONAPI_KEY` the TonAPI key); `429` = plan limit; `400/404` = wrong URL/params. Search the current TonCenter and TonAPI docs for any endpoint/limit/header change.
4. Check the payout wallet: derived address equals `TON_PAY_ADDRESS`; GRAM balance for fees (≥ 0.05 GRAM); USDT-on-GRAM balance ≥ the sum of pending GRAM withdrawals; W5R1 wallet deployed (seqno readable).
5. Check the DB side: `defer_withdrawal`, `payout_lock_take/release` exist and return no error (the current code does not check the error of the `defer_withdrawal` RPC — fix that: log and surface it). Check whether a stale `payout_lock` row blocks all payouts (`until` in the future with an old holder) and add expiry/cleanup.
6. Fix the **actual** cause you found. If several causes exist, fix all.

### 2.3 Make errors visible
* Admin → Withdrawals list: show `retry_count`, `next_retry_at`, `last_error` (short, no secrets), `needs_review`, and buttons **Retry now** (resets `retry_count=0`, `next_retry_at=null`, `needs_review=false` when no unresolved `msg_hash` exists) and **Pay manually**.
* `/health` (Task 6) shows the same summary.
* User sees only "Processing" — never raw errors.

### 2.4 Retry policy
Keep `[30,60,120,300,600]`, but only count real failures (not "lock busy" or "waiting for another payout"). Network/429/5xx → retry; wrong address / insufficient funds / banned → no blind retry, go to `needs_review` with an admin alert. The "no double pay" rules from Prompt 7 stay untouched (persist `msg_hash` before broadcast, one GRAM payout at a time, settle an unclear earlier message before any retry).

### 2.5 Deploy the backend
The server code and secrets only take effect after a **new deployment**. Do all of the following:
1. Apply any new migration (`0009_…`, Task 3/4/6/7) to the live database.
2. Publish/deploy the latest code. If you cannot press Publish yourself, finish everything else and tell me **explicitly** to press **Publish → Update** and then run the existing bot setup action (it re-registers both webhooks).
3. After deployment, call the health route and `tonProviderHealth()` (via the new `/health` data) and confirm `keyed: true` for both providers, DB ok, both webhooks registered.

### 2.6 Pay the pending withdrawals (I authorise this)
The pending withdrawals are **my own test withdrawals**; please pay them with autopay now.
1. List them (2.2). For each one with an existing `msg_hash`: first settle it (did that message already land on-chain? check by message hash on TonAPI/TonCenter). Landed → mark paid with that tx; not landed and expired → safe to resend; unclear → leave for manual review and tell me.
2. Reset `retry_count=0`, `next_retry_at=null` for the rest, then pay them **one at a time** through the normal single path `reviewWithdrawal({auto:true})` (never a second code path). Wait for each result.
3. For every payment report: withdrawal id (short), chain, net USDT, final status, **transaction link** (tonviewer / bscscan), and check on-chain that the destination received it.
4. If your environment cannot send real funds, say so plainly, make sure the deployed app will do it (cron tick / admin "Auto pay" button), and tell me exactly what to press.

### 2.7 Scheduler
The safety-net route `/api/public/cron/tick` needs a caller every minute. Check Lovable's docs for scheduled jobs (e.g. `pg_cron` + `pg_net` calling the route with the `LOVABLE_CRON_SECRET` bearer). Set it up if possible; if not, tell me exactly what to configure.

### 2.8 Tests
Extend `payout.test.ts`: key present/absent, 401 vs 429 vs 5xx classification, stale lock, `defer_withdrawal` RPC error surfaced, retry-now, two simultaneous triggers = one transfer, 429 during `sendBoc` = no second transfer, BEP20 path unchanged.

---

## 3. TASK 3 — Fake coins: verify by official contract, never credit, tag `fake`, save for admin review

### 3.1 What the code does today (confirmed)
* A transfer is marked `fake` only when its **symbol looks like USDT/USDC** and its contract is not the official one. A fake token called "ETH", "BNB", "GRAM" or anything else is silently ignored (not saved, admin never sees it).
* Fake rows use the same dedupe key `(tx_hash, chain, asset)` as real ones, so a fake "USDT" and a real USDT in the same transaction collide.
* There is **no admin review screen** for `fake` rows. The `contract` is not stored.

### 3.2 Rules (apply on every path: user scan, background scan, `verifyEvmHash`, `verifyTonHash`, ad-order payments, admin hash verification)
A transfer is **real** only if:
* **EVM native** (ETH on Ethereum, BNB on BNB Chain): it is a plain external transfer (`category: external`) — never a token event.
* **EVM token**: the **contract address** equals the allowlist entry for that chain (compare lower-cased addresses; never trust symbol, name or decimals returned by the API).
* **GRAM native**: a real value transfer (TonAPI `TonTransfer` / TonCenter in_msg with value) — never an event that only *says* GRAM.
* **GRAM jetton (USDT)**: the jetton **master** address, converted to raw `0:…` form, equals the official USDT master `0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe` (`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`). Any other jetton — even named "USDT" or "GRAM" — is fake. TonAPI's own `verification` field (whitelist/blacklist) is an extra signal only, never a reason to accept.
* Everything else that arrives at one of our deposit addresses (any other token contract / jetton) is **fake/unknown**.

**Verify the allowlist from official sources via web search before relying on it** (Tether and Circle official address pages, bscscan/etherscan, TON docs) and put the result in a single constants file `src/lib/assets.server.ts` with a comment and source link per address. Current expected values to confirm: Ethereum USDT `0xdac17f958d2ee523a2206206994597c13d831ec7`, Ethereum USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, BNB Chain USDT (BSC-USD) `0x55d398326f99059ff775485246999027b3197955`, BNB Chain USDC `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`. Fix the file if a source says otherwise.

### 3.3 What to do with a fake transfer
1. **Never credit it** (no gems, no `total_deposit`, no bonus).
2. **Save it** in `deposits` with `status='fake'`, using a **separate dedupe key** so it can never block or replace a real deposit: `asset = 'FAKE:' || upper(left(symbol,8)) || ':' || left(contract_hash, 6)` (symbol sanitised: letters/digits only).
3. Add columns (migration `0009_prompt8_*.sql`): `deposits.contract_address text`, `claimed_symbol text`, `review_status text default 'pending' check in ('pending','dismissed','approved','rejected')`, `reviewed_by bigint`, `reviewed_at timestamptz`, `review_note text`, `meta jsonb` (capped to a few hundred bytes: decimals, raw amount, provider name, `verification` flag).
4. **Tag it clearly**: in the user's deposit history show a red `FAKE` tag ("not credited"); in admin show a red `FAKE` badge. Notify the user once per transaction (existing message, new design) — never repeat on every check.
5. **Admin review tab** ("Fake deposits"): list pending items first (user id, chain, claimed symbol, contract, amount, tx link, time, how many fakes this user has sent). Actions: **Dismiss** (reviewed, nothing else), **Ban user** (existing ban function), **Re-verify** (runs the official check again; only if the transfer now passes the allowlist does it go through the normal idempotent `credit()`; otherwise refuse with a clear message). Admin can **never** credit a fake by typing an amount from this screen.
6. Admin alert: one batched Telegram message to admins ("⚠️ N new fake deposits — review") at most once per 10 minutes, with a button to open the admin tab.
7. **Spam protection**: an attacker can send thousands of junk tokens cheaply. Store at most **20 new fake rows per user per 24 h**, count the rest in a counter column on `player_state` (`fake_count`), and show the counter in admin.
8. Do not let a fake record, a failed price lookup or any error ever hide a real deposit in the same scan.

### 3.4 Tests (mandatory)
Fixtures for: real USDT BSC, real USDC ETH, fake "USDT" on BSC (different contract), fake token named "BNB"/"ETH"/"GRAM", fake jetton named "USDT" on GRAM, jetton with right symbol but wrong master, real USDT jetton, native GRAM transfer, a transaction with a real and a fake transfer together (real credited once, fake saved once, no collision), duplicate scan (no duplicates), 25 fake transfers from one sender (cap works), re-verify of a fake (refused), contract address given in checksum vs lowercase form (same result).

---

## 4. TASK 4 — Referral stays pending until the friend buys a character AND completes a task

Rule: a referral is **pending** until the invited friend has done **both**: (1) hired at least one character, and (2) completed at least one task from the Tasks tab. Only then it becomes **active** (`bonus_paid = true`, counts as a friend, fixed referral bonus is paid, referrer is notified).

Implementation:
1. Migration: `referrals.bought_at timestamptz`, `referrals.task_at timestamptz`. New SQL function `ref_try_activate(p_tg bigint)` that, under a row lock, sets activation only if both columns are set and `bonus_paid` is false, pays the existing `ref_bonus_gems` once (idempotent), and returns the referrer id + bonus (or null).
2. `game_buy_character`: set `bought_at` (first purchase only) and call `ref_try_activate`. Today this function activates the referral right at the first purchase — remove that.
3. `task_complete`: set `task_at` (first task only) and call `ref_try_activate`. Return `refActivated/refBonus` in the same JSON shape as the buy function so the server code can notify the referrer from either path.
4. Keep the existing percentage commissions (`ref_mage_pct`, `ref_magic_pct`) behaving exactly as they do today; **only the activation trigger changes**. In your final report tell me whether those commissions are paid while a referral is still pending, so I can decide.
5. Places that count active referrals (`me_json` friends/pending counts, free-withdraw rule, leaderboard) must use the new meaning automatically — check each.
6. UI (Partners tab, friends list): a pending friend shows what is missing, e.g. `⏳ Pending · ☐ Character · ☑ Task`; all 4 locales. Referrer notification texts: "joined (pending)" and "now active" in the new design style.
7. Already-active old referrals (`bonus_paid = true`) stay active (backfill `bought_at/task_at = created_at` for them).
8. Tests: only character → pending; only task → pending; character then task → active once; task then character → active once; repeated actions don't pay twice; self-referral still impossible; free-withdraw count follows active referrals only.

---

## 5. TASK 5 — Withdraw: verify the address (wrong address = no withdrawal)

Validation runs **on the server before any gems are deducted** (`requestWithdrawal`, before the `request_withdrawal` RPC) and again before sending (`sendUsdtBep20`, `sendUsdtTon`, admin manual pay). The client shows the same checks instantly. One shared module `src/lib/address.ts` (pure functions, used by both sides; lazy-load `@ton/core` and `ethers` on the client).

Normalise first: trim, remove zero-width/invisible characters, reject any inner whitespace.

**BEP20 (BNB Chain):**
* Must match `^0x[0-9a-fA-F]{40}$`.
* If the address has mixed case, verify the **EIP-55 checksum** (`ethers.getAddress` must not throw). All-lowercase / all-uppercase is accepted (no checksum info).
* Reject: zero address, `0x…dEaD` burn addresses, the USDT/USDC/token contracts from the allowlist, our payout wallet, our admin/system addresses, and **any per-user deposit address in `user_deposit_addresses`** (it would just loop back as a deposit).
* Optional contract check (`eth_getCode`, 3 s timeout, fail-open): if the address is a contract, require an explicit extra confirmation in the UI ("This is a contract address, not a normal wallet") and send a `confirmContract:true` flag; without it → reject.

**GRAM (USDT on GRAM):**
* Use `Address.parseFriendly` for friendly addresses (it verifies the CRC16 checksum; any typo fails) and `Address.parseRaw` for `0:hex`. Reject: bad checksum, **testnet-only** flag, workchain ≠ 0, the zero/burn address, our payout wallet, our shared GRAM deposit address (sending there without a memo = lost money), the USDT jetton master, and anything that is not a valid address.
* Optional on-chain hint (cached, 3 s timeout, fail-open): if TonAPI says the account does not exist at all, show a warning and require explicit confirmation ("This wallet has never been used — double-check the address").
* Show a fixed warning text: "Exchange wallets may require a memo/tag. Withdrawals are sent without one."
* Store/send the **normalised** address (user-friendly, non-bounceable `UQ…`), keep the original string in a note field for support.

**Errors** use reason codes → localized messages: `bad_format`, `bad_checksum`, `wrong_network`, `testnet`, `burn_address`, `own_address`, `token_contract`, `contract_address`, `unused_wallet`. Rate limit stays. No gems are deducted and no withdrawal row is created when validation fails.

**Tests:** valid + invalid checksum for BEP20 and GRAM, a BEP20 address pasted into GRAM and vice versa, testnet address, zero address, token contract, our deposit address, whitespace/zero-width tricks, lowercase address, contract-confirmation flow, and a test that proves **no DB write happens** for any rejected address.

---

## 6. TASK 6 — `/health` command (and safe mode) for admins

### 6.1 Command
* `@MagiqAiBot /health` — **admins only** get the full report. Any other user gets one line only: `✅ Online · ping N ms`. Same command on @MagiqAdvBot (admins only, adv-specific data). Register it in `setMyCommands` (admin scope for the full one). Rate limit 10/min per admin.
* Follow the bot UX rule: show `⏳ Checking system health…` first, run all checks **in parallel** (each with a 4 s limit, total ≤ 8 s), then replace it with the report. A failing check shows 🔴 + the reason; nothing may throw or hang.
* The report is edited in place when the admin presses **🔄 Refresh**. Buttons: `🔄 Refresh`, `🛡 Safe mode ON/OFF`, `🧾 Pending withdrawals`, `⚠️ Fake deposits`, `🔮 Open admin`.

### 6.2 What the report shows (🟢 ok / 🟡 warning / 🔴 problem, with real numbers)
1. **Ping**: Telegram API round trip (`getMe`), backend→database round trip (median of 3), delay of this update (`now − message.date`).
2. **Mode**: safe mode on/off (since when, by whom); switches for deposits, withdrawals, autopay (global + per method).
3. **Database**: latency, connections used / max, longest running query (s), blocked locks, DB size. Provided by a new service-role-only SQL function `health_db()`.
4. **Backend**: app version/deploy time (build id if available), isolate uptime, cache hit-rate per namespace, error count in the last 15 min (ring buffer in memory), last cron tick time + result, last background-job errors.
5. **Webhooks**: `getWebhookInfo` for both bots — URL is the expected one, `pending_update_count`, `last_error_date/message`, `max_connections`.
6. **GRAM network**: TonCenter and TonAPI — ok/paused, `keyed` true/false, requests, 429 count, last error, latency of a tiny test call.
7. **EVM**: NodeReal ETH + BSC latency (`eth_blockNumber`) and key present.
8. **Prices**: GRAM, BNB, ETH — value age and source; stale warning > 5 min.
9. **Wallets**: payout wallets (BEP20 + GRAM): GRAM/BNB for fees, USDT balance vs sum of pending withdrawals; low-balance flags; GRAM deposit address configured.
10. **Queues**: pending withdrawals (count, oldest age), autopay retrying (count, max `retry_count`, most common `last_error`), `needs_review`, `awaiting_price` deposits, unreviewed fake deposits, ad orders waiting for payment.
11. **Secrets**: required env names present/missing — **names only, never values or lengths**.
12. **Verdict** at the top: overall 🟢/🟡/🔴 and a short **"Actions"** list written for the admin (e.g. "Add TONAPI_KEY", "Fund payout wallet with GRAM", "Run /safemode on", "Re-register webhook").

Design with the Telegram HTML system from Prompt 7 (`<b>`, `<i>`, `<code>`, `<blockquote>`, thin separators). Keep it under 4000 characters; if longer, split into two messages (second one `<blockquote expandable>`).

### 6.3 Safe mode
New setting `safe_mode` (`on/off`, plus `safe_mode_since`, `safe_mode_by`), toggled with `/safemode on|off`, the button above and an admin-panel switch. When **on**: autopay is disabled, new withdrawal requests are paused with a clear user message ("Withdrawals are temporarily paused for safety"), queued ones stay pending, the cron tick skips payouts. Deposits keep being detected and credited (money coming in is safe), buying and mining keep working. Enforce it **inside** the SQL function `request_withdrawal` and in `reviewWithdrawal(auto)` so no code path can bypass it. Admin manual pay stays possible. Log every toggle in `admin_actions`.

### 6.4 Also
* `GET /api/public/health` (Task 1) stays minimal; `/health` is the detailed admin view. Show the same data as a card in the admin panel (reuse the same function).
* Tests with mocked providers: everything green, DB slow, TonCenter 429, webhook error, wallet low, safe mode on blocks withdrawals and autopay, non-admin sees only the one-liner.

---

## 7. TASK 7 — @MagiqAdvBot: "My Tasks", full status, rate limits, caching

### 7.1 Menu
`/start` shows a main menu (new design): `📣 New promotion`, `📋 My Tasks`, `❓ Help`. "New promotion" starts the existing flow (channel / group / bot). Keep the Prompt 7 flow for every button: **delete clicked message → ⏳ processing message → result → delete processing message**, per-chat serialisation, `answerCallbackQuery` fire-and-forget.

### 7.2 My Tasks
* **List** (5 per page, ◀ ▶ pagination): newest first. Header summary: active / waiting for payment / completed / cancelled counts and total spent in USD. Each line: type icon (📣/👥/🤖), title, status badge, progress `▰▰▰▱▱ 60% (300/500)`.
* **Statuses** (map every real state in `adv_orders` + `tasks`; inspect both tables first): `📝 Draft` (unfinished), `⏳ Waiting for payment`, `✅ Paid · starting`, `🚀 Running`, `🏁 Completed`, `✖️ Cancelled`, `⚠️ Under review`. If the schema lacks a state you need, add it in the migration.
* **Detail view** for one task: type, link, title, members ordered / joined / remaining, price per member, total USD, coin + network, amount, created / paid / completed dates, payment tx as a link inside `<tg-spoiler>`, and the status explanation in a `<blockquote>`.
* **Buttons per status**: `🔄 Refresh` (always), `✅ Check deposit` (waiting for payment), `▶ Continue` (draft/waiting), `✖️ Cancel` (only draft / waiting-for-payment, never after payment), `⬅ Back`, `🏠 Menu`. Do **not** offer stop/refund for paid tasks (not designed yet); the detail view says "Need help? Contact the admin" instead.
* Joined-members count comes from `task_completions`; compute with one grouped query for the whole page, not one query per task.
* Empty state: friendly message + `📣 New promotion`.

### 7.3 Rate limits (in memory first, DB only for money actions)
* Per user: messages 20/min, callbacks 40/min, `/start` 5/min, Check deposit 6/min (this one also via the existing DB `rate_hit`), My Tasks refresh 20/min.
* When exceeded: answer the callback with a short "Slow down ⏳" toast once, drop the rest silently. Over 100 events/min → mute that user for 5 minutes and log a counter (visible in `/health`).
* **Update dedupe**: remember the last 2000 `update_id`s (Telegram retries on timeouts) and ignore repeats.
* Ignore non-private chats, bots, and oversized texts (> 500 chars) cheaply before any DB call.
* Same limits (own counters) for @MagiqAiBot `/start` and admin buttons.

### 7.4 Caching (use `cached()` / `invalidate()` from `cache.server.ts`)
| Data | TTL | Invalidate |
|------|-----|-----------|
| User's task list page | 15 s | on any order patch / payment / cancel / task completion |
| Joined-count per task | 10 s | on `task_complete` |
| Live order of a chat | 10 min write-through (already exists) | on patch |
| Settings, wallet index, GRAM address, prices | as in Prompt 7 | as before |
Never cache payment state used for crediting: `Check deposit` always reads the order fresh from the DB.

### 7.5 Tests
Extend `adv-flow.test.ts`: My Tasks empty / one / 12 tasks (pagination), every status's buttons, cancel allowed vs not allowed, detail view escapes `<`, `&`, quotes in titles, rate-limit mute, duplicate `update_id`, cache invalidation after a payment, `/health` admin vs non-admin.

---

## 8. TASK 8 — Docs, migration, final verification

### 8.1 Housekeeping
* One migration `drizzle/migrations/0009_prompt8_*.sql` (+ snapshot/journal as the other migrations): deposits review columns, referral columns + `ref_try_activate`, `health_db()`, safe-mode/setting defaults, indexes, cleanup helpers, any adv status additions. All new functions: `SECURITY DEFINER`, `search_path` set, `REVOKE` from public/anon/authenticated, `GRANT` to `service_role`. New tables: RLS on.
* Update `docs/system-design.md` (new sections: boot path and timeouts, health/safe mode, fake-coin policy and allowlist, referral activation, address validation, adv My Tasks, rate-limit table, DB-reset safeguards), `AGENTS.md`, `src/lib/AGENTS.md` (short rules + "Why"), `roadmap.md` (`- [x] Prompt8 …`, plus the owner actions below), and set "Next prompt: Prompt9".
* Run and make green: `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build`.

### 8.2 Real checks you must actually do (or state exactly what you could not)
1. App opens from a cold start in Telegram; time to first paint; kill the config call / slow the DB artificially → app still opens or shows the Retry screen within 8 s (never an endless spinner).
2. Task 1 diagnostics report (numbers) and what you changed; if you reset the DB, the proof that the safeguards in 1.5 work (old on-chain transfer is **not** credited).
3. Deployment done (or the exact button I must press); both providers `keyed:true`; webhooks registered.
4. Pending withdrawals: each payment with tx link and on-chain confirmation, or the exact reason it could not be sent.
5. Fake-coin test with real chain data if possible (send a tiny fake token to a test deposit address), otherwise fixtures; fake saved + tagged + visible in admin review + not credited; real deposit in the same scan still credited once.
6. Referral flow end-to-end with two test accounts (all four orders of events in 4).
7. Withdraw address rejections (no gems deducted, no row created) and one valid withdrawal for each method.
8. `/health` in both bots as admin and as a normal user; safe mode on → withdraw request refused, autopay skipped; off → works again.
9. My Tasks with real orders in every state; rate limit mute; duplicate update.
10. Re-run the Prompt 7 regression list quickly: header box, blue withdraw selection, GRAM/GRAM-USDT deposit check, BEP20 deposit, ad-bot flow, caching (no balance cached).
11. Security regression: no secret in logs/responses/health output, admin-only routes still admin-only, initData still verified, ledger append-only.

### 8.3 Self-check before you answer
Re-read this file from the top and tick every task, every numbered rule and every test. Anything not done or not testable → say so.

### 8.4 Final answer format
One table:

| Item | Done? | How verified (real / mocked / not possible) | Result |
|------|-------|--------------------------------------------|--------|

Then: root cause of the app not opening (with numbers), root cause of the autopay retry (the real `last_error`), whether the DB was reset and why, files created/changed, migration(s), new/changed env vars, the commission question from Task 4, and the **owner actions**:
1. Press **Publish → Update** (if you could not) and run the bot setup action so both webhooks are re-registered.
2. Confirm `TON_API_KEY` = TonCenter key and `TONAPI_KEY` = TonAPI key (correct service for each).
3. Set the minute scheduler for `/api/public/cron/tick` if you could not.
4. Keep the GRAM payout wallet funded with GRAM (fees) and USDT.
5. Make @MagiqAiBot admin in required / payment / advertised channels.
