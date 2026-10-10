# ADMIN PANEL — COMMON FEATURES (har Telegram Mini App bot me same)

> **Lovable ko bolo:** "Admin panel is file ke hisaab se banao. Har tab ke fields, actions, empty/error states aur confirmation dialogs implement karo. Admin API sirf `admin-api` edge function se. Existing data delete mat karo."
>
> App-specific tabs (tasks, plans, mining, game) upar se add hote hain; neeche wale tabs har bot me common hain.

---

## 0. Admin access (pehle ye)

| Rule | Detail |
|---|---|
| Admin kaun | **Ek fixed admin**: `ADMIN_ID` (env secret). Koi admins table nahi, "Make/Remove Admin" nahi |
| Entry | App me admin button/menu nahi. Sirf admin id ke liye hidden route (e.g. logo pe 5 tap) ya bot me secret command |
| Server check | Har `admin-api` call: verified initData (`auth_date ≤ 5 min`) + `user.id == ADMIN_ID` + admin token |
| 2nd factor | PIN (server pe salted hash) → 30 min ka signed token (admin id + device fp bound). 5 galat PIN = 15 min lock |
| Sensitive actions | Deposit address badalna, payout limit/autopay on, bade payout approve, all-user broadcast, balance bulk-edit → PIN dobara |
| Alerts | Naye device se admin login = bot DM; 3+ failed PIN = DM |
| Audit | Har admin action `audit_log` me (actor, action, target, before/after, time), 90 din retention |
| UI | Mobile-first, bottom/side nav, tables horizontal scroll, har list me search + pagination (20/page), har async button `ActionButton` (disabled + spinner), har screen skeleton/empty/error+Retry, destructive action pe confirm dialog |

Admin tabs order (nav): **Dashboard · Users · Deposits · Withdrawals · Autopay · Broadcast · Check Deposit · Assets & Chains · Referral · Security · Settings · Logs & Health**

---

## 1. Dashboard

Data **cached rollup** se (cron har 1-5 min), live `COUNT(*)` nahi.

| Card / chart | Detail |
|---|---|
| Users | Total, new today (UTC), active 24h/7d, banned, unreachable (bot block kiya), `verify_state` split (human / pending / unreachable / bot) |
| Deposits | Aaj / 7d / total (USD), count, chain-wise split, review queue count |
| Withdrawals | Pending count + amount, queued, sending, paid aaj, rejected, needs_review |
| Money | Total user balances (coins), total deposit, total withdrawn, net (deposit − withdraw) |
| Hot wallet | Per chain: native gas balance + USDT balance (low = red badge) |
| Charts | Daily new users, daily deposit USD, daily withdraw USD (14/30 din toggle) |
| Queue/System | Pending jobs, failed jobs, scanner last run + lag, provider status (TonCenter/TonAPI/NodeReal), safe-mode badge |
| Quick actions | Check Deposit, Pending withdrawals, Broadcast, Maintenance toggle |
| Top lists | Top 10 depositors, top 10 referrers (cached) |

Refresh button + "last updated" time. Error state: Retry.

---

## 2. Users

### 2.1 List + search
- **Default me list khali** (heavy query nahi); search ke baad results.
- Search: Telegram ID, username, display name (jinka username nahi unke liye bhi), wallet index, referrer ID. Exact + prefix.
- Filters: banned, frozen, unverified/bot, has deposit, joined date range, country/lang (agar store).
- Sort: joined, balance, total deposit, last seen. Keyset pagination.
- Export CSV (selected filters, PIN confirm).

### 2.2 User detail card
| Section | Fields |
|---|---|
| Identity | ID, name, username (tap = Telegram profile link), language, joined, last seen, `verify_state`, reachable, premium |
| Balances | Coin, USDT, other currencies, frozen amount, withdrawable |
| Totals | Total deposit (USD), total withdrawn (amount + count), pending withdrawals |
| Wallet | `wallet_index`, derived deposit addresses (on-demand, DB me store nahi), memo (`PREFIX-id`) |
| Referral | Invited by, referral status, invited count, referral earnings |
| Security | device_fp (hash), IP hash, other accounts on same device (list), flags/risk score, bans |
| History tabs | Ledger (paginated), Deposits, Withdrawals, Tasks/activity, Referrals |

### 2.3 Actions (har ek confirm + reason + audit)
| Action | Detail |
|---|---|
| Add / Remove balance | currency, amount, reason; ledger `reason='admin'` |
| Freeze / Unfreeze balance | Frozen amount withdrawable se alag |
| Ban / Unban | + reason; ban pe pending withdraw auto-reject (+refund option) |
| Verify state override | Manually `human` set karo (unreachable real user ke liye) |
| Manual deposit | tx hash + chain + asset + amount; dedup by tx hash |
| Add spins / tasks credit | (app-specific modules) |
| Send message | Single user DM (Broadcast tab ka shortcut) |
| Reset daily limits | Ad/task daily counters |
| Merge/flag duplicate | Same-device accounts mark |
| Delete user data | Sirf PIN + double confirm (rare) |

No "Make admin / Remove admin" (single fixed admin).

---

## 3. Deposits

Tabs: **Credited · Review · Ignored stats · Manual credit**

| Tab | Detail |
|---|---|
| Credited | Table: time, user, chain, asset, amount, USD, coins, tx (explorer link), memo. Filters: chain/asset/date/user. Totals row |
| Review | `deposit_review` rows (below_min, no_memo, unmatched user, unlisted-but-real token): row actions — **Credit to user** (user id enter), **Mark ignored**, **Refund note**. 7 din TTL |
| Ignored stats | Counters per day/reason (unlisted_token, no_memo, outgoing, dust) — bina rows ke (Redis/rollup), "fake token attempts" trend |
| Manual credit | Form: user id, chain, asset, tx hash, amount → `credit_deposit` (duplicate tx reject) |

Extra: deposit detail drawer (raw tx info, provider, confirmations, notify status), "Re-send DM".

---

## 4. Withdrawals

Sub-tabs: **Pending · Queued/Sending · Paid · Rejected · Needs review**

| Item | Detail |
|---|---|
| Row | Seq #, time, user (tap → user card), network, amount, fee, address (short + copy), auto? flag, risk badges (same device, new account, unverified) |
| Pending actions | **Approve → Queue (auto-pay)** · **Mark Paid manually** (tx hash input) · **Reject** (reason + "Refund balance?" yes/no) |
| Queued/Sending | Attempt count, last error, tx hash, **Retry** (pehle chain check), **Cancel** (refund) |
| Needs review | Reason (timeout, seqno moved, hot wallet low), buttons: Check on-chain, Mark paid, Re-queue, Reject+refund |
| Bulk | Select multiple → approve/reject (PIN) |
| Filters | Date, network, amount range, user, auto/manual |
| Totals | Pending amount, today paid amount |
| Notifications | Approve/Reject par user DM + payment-channel post (masked) automatic |

Reject flow: dialog → reason (preset + custom) → "Refund amount + fee?" → confirm.

---

## 5. Autopay

| Section | Fields / actions |
|---|---|
| Master switch | `autopay_enabled` (shuru me OFF), **Pause now** (emergency stop) |
| Rules | `autopay_limit_usd`, per-network limit, min account age, require `human`, max pending per user, daily payout cap (user + total) |
| Hot wallets | Per chain: address (read-only, derived), native gas balance, USDT balance, low-balance threshold, "Top-up needed" badge |
| Queue monitor | Queued / sending / sent / failed counts, oldest queued age, last success time, worker heartbeat |
| Error policy | `autopay_pause_on_error` (N lagatar failure → auto pause + DM), retry backoff display |
| Gas settings | `ton_payout_gas_attach`, EVM gas multiplier (e.g. 1.2), max gas price cap |
| Test payout | Small test send to admin address (PIN) |
| Logs | Last 50 payout attempts (id, network, status, tx, error) |

Autopay details: `auto-withdraw-deposit.md` section 5.

---

## 6. Broadcast (all + single user)

| Field | Detail |
|---|---|
| Target | **All users** · **Single user** (ID/username search) · **Segment** (new 24h, depositors, non-depositors, inactive 7d, language) · **Test (sirf mujhe)** |
| Message | HTML text (Telegram-allowed tags: b, i, u, s, code, pre, a, blockquote, spoiler), live preview, char counter |
| Media | Image URL / GIF URL (optional) |
| Buttons | Max **2 inline buttons** (text + URL ya Mini App link) |
| Options | Schedule time, "pin message", silent (no notification) |
| Safety | All-user send = PIN + confirm dialog with recipient count; HTML sanitize server pe |
| Delivery | `jobs` queue, 25-30 msg/sec, 429 `retry_after` respect; blocked/deactivated users auto `reachable=false` |
| Progress | Live: queued / sent / failed / blocked, pause / resume / cancel |
| History | Past broadcasts: time, target, counts, content preview, "Duplicate" button |

Single-user DM: same editor, target = one user; success/fail instantly dikhao ("Forbidden: blocked" etc. human-friendly).

---

## 7. Check Deposit (admin tool)

| Tool | Detail |
|---|---|
| By user | User ID → us user ke addresses/memo ka **scan now** job queue (cooldown 10s), result: naya mila / nahi mila + kyu |
| By tx hash | Chain + tx hash → provider se fetch → dikhao: to, amount, asset, whitelisted?, memo match?, confirmations, already credited? → **Credit now** button (agar valid) |
| Scanner control | Run scanner now, per-chain cursor (view/reset-to-block with PIN), last run, lag, last error |
| Provider test | TonCenter / TonAPI / NodeReal ping + latency + key valid status |
| Missing deposit finder | Date range + chain → on-chain incoming list vs `deposits` diff (kya credit nahi hua) |

---

## 8. Assets & Chains (listing)

| Item | Detail |
|---|---|
| Chains | Enable/disable deposit & withdraw per chain, confirmations, explorer URL template, RPC provider status |
| Assets | List: symbol, chain, kind, **contract address (mandatory for tokens)**, decimals, min deposit, min withdraw, can_deposit, can_withdraw, enabled, image |
| Add-asset wizard | **Chain → symbol → name → contract address → (auto fetch info: supply/price/volume/decimals/logo) → admin confirm → list** |
| Validation | Duplicate contract block, address format check, decimals on-chain verify, fake-lookalike warning (same symbol existing) |
| Images | Logo preview, override upload (images.md) |
| Fees | Per-asset withdraw fee (flat/percent) |

---

## 9. Referral

| Setting | Detail |
|---|---|
| Rewards | Per-invite reward, deposit bonus %, level (agar multi-level) |
| Activation rule | Referral `pending` kab `active` (e.g. human + 1 task / 1 deposit) |
| Anti-abuse | Same device/IP no reward, self-referral block, bot-account referral cancel |
| Lists | Top referrers, referral tree of a user, pending/cancelled referrals |
| Actions | Cancel referral, recompute, manual reward |
| Link format | `https://t.me/{BOT}/{SHORT}?startapp={userid}` (setting) |

---

## 10. Security

| Tool | Detail |
|---|---|
| Suspicious accounts | Computed view: same device ≥2 accounts, new + instant withdraw, unverified/bot state, high request rate, many referrals same IP → risk score, **bulk ban** |
| Bans | Tabs: Users · Devices · IPs (add/remove, reason, date) |
| Rate-limit stats | Top 429 hitters (user/IP), recent blocks |
| Bot-check results | Welcome-probe outcomes count (human / bot / blocked / unreachable) |
| Admin sessions | Last admin logins (device hash, time), revoke token (rotate `ADMIN_TOKEN_SECRET` instruction) |
| Withdraw guards | Free-withdraw cap, min account age, per-user daily cap (links to Settings) |

---

## 11. Settings (grouped, har value editable, cache auto-invalidate)

| Group | Keys (examples) |
|---|---|
| General | App name, maintenance mode + message, language defaults, support links |
| Branding/Content | /start text (HTML), welcome media (image/GIF URL → file_id cache), button labels/links (Channel, Chat, Open App) |
| Money | `coin_per_usd`, currencies list, rounding, fees (mode+value), min deposit/withdraw |
| Deposit | Addresses (TON shared), memo prefix, confirmations, scan interval, watch TTL |
| Withdraw | Enabled networks, caps, account age, free-withdraw cap |
| Autopay | Section 5 keys |
| Rewards | Daily task rewards (individually), spin segments (value **and** probability), ad reward, ad daily limit, cooldown seconds |
| Ads | Adsgram block ID, Monetag zone ID (admin changeable) |
| Channels | Required join channels (verify via Bot API), payment channel ID, log channel |
| Limits | Rate limits (per user/IP/action), daily reset time (UTC fixed) |
| Notifications | Which events DM user (deposit, withdraw, referral, profit claim) |
| Language | Enabled languages, default |

Har setting: label, type, default, validation, "Save" (ActionButton), "Reset to default", last updated by/at. Money-related change = PIN.

---

## 12. Logs & Health

| Tab | Detail |
|---|---|
| Audit log | Admin actions filter by action/date |
| Jobs | Queue list (type, status, attempts, last error), retry failed, purge done |
| Webhook | Last updates received, pending update count (`getWebhookInfo`), re-set webhook button |
| System health | DB ping, Redis ping, queue depth, scanner lag, payout worker heartbeat, providers latency, safe-mode toggle |
| **Config health (sirf admin ko dikhta hai)** | Kaun se Lovable Cloud secrets set/missing hain (names only, values kabhi nahi) — **missing key ka message user ko kabhi nahi dikhta**, sirf yaha |
| Errors | Last 100 server errors (message, endpoint, time) |
| `/health` bot command | Admin DM: ping, DB, backend, queue, safe mode |

---

## 13. App-specific tabs (jab app me ho)

| Tab | Detail |
|---|---|
| Tasks | Promote: Pending/Running/Paused/Done; Partner: Create/Created. Approve (live), Reject (refund?), Pause/Resume/Delete (response dikhaye). Har category (channel/bot/other) admin approval. Channel task: bot admin check status |
| Promo codes | Create (code, reward, max uses), list, delete, usage |
| Spin | Segment value + probability dono edit, per-segment color, daily free spins, ad spins |
| Ads | Provider IDs, reward, limits, cooldown, stats (views/day) |
| Plans/Mining/Game | App ke hisaab se (catalog CRUD, levels, costs) |
| Leaderboard | Cache refresh now |
| Sponsored payouts | Task creators ke cost/refund |

---

## 14. Admin API (`admin-api`) — action list

`POST /functions/v1/admin-api` body `{ action, ...params }`, headers: `x-tg-init-data`, `x-device-fp`, `x-admin-token`.

| Group | Actions |
|---|---|
| Auth | `login_pin`, `logout`, `whoami` |
| Dashboard | `dash_summary`, `dash_charts` |
| Users | `user_search`, `user_get`, `user_balance_adjust`, `user_freeze`, `user_ban`, `user_unban`, `user_verify_override`, `user_manual_deposit`, `user_ledger`, `users_export` |
| Deposits | `dep_list`, `dep_review_list`, `dep_review_credit`, `dep_review_ignore`, `dep_stats`, `dep_manual_credit` |
| Withdrawals | `wd_list`, `wd_approve`, `wd_mark_paid`, `wd_reject`, `wd_retry`, `wd_cancel`, `wd_bulk` |
| Autopay | `ap_get`, `ap_set`, `ap_pause`, `ap_queue`, `ap_wallets`, `ap_test_payout` |
| Broadcast | `bc_preview`, `bc_send`, `bc_send_single`, `bc_progress`, `bc_control`, `bc_history` |
| Check deposit | `cd_user`, `cd_tx`, `cd_scanner_run`, `cd_cursor`, `cd_providers`, `cd_missing` |
| Assets | `asset_list`, `asset_add`, `asset_update`, `asset_lookup`, `chain_set` |
| Referral | `ref_settings`, `ref_list`, `ref_cancel` |
| Security | `sec_suspicious`, `sec_ban_add`, `sec_ban_remove`, `sec_stats` |
| Settings | `settings_get`, `settings_set`, `settings_reset` |
| Logs/Health | `audit_list`, `jobs_list`, `jobs_retry`, `webhook_info`, `webhook_set`, `health`, `config_health`, `safe_mode_set` |

Har action: input validation (zod), rate limit (60/min), audit log, standard response `{ ok, data }` ya `{ ok:false, code, message }`.

---

## 15. Admin DB tables (minimal)

`settings`, `assets`, `audit_log` (capped), `bans`, `jobs`, `locks`, `scan_state`, `stats` (counters), `broadcasts`, `deposit_review` (TTL). Baaki tables (users, balances, ledger, deposits, withdrawals) common schema se (CORE_METHODS.md, auto-withdraw-deposit.md).

---

## 16. Checklist (admin panel)

- [ ] Non-admin (alag Telegram account) har `admin-api` action pe 403
- [ ] PIN lock, token expiry, new-device DM kaam kar rahe
- [ ] Koi "add admin" feature nahi
- [ ] Users tab default khali, search sab 4 tarah se kaam karta (ID, username, name, wallet index)
- [ ] Reject withdraw me refund prompt; approve → queue; masked channel post
- [ ] Broadcast: all/single/segment/test, HTML sanitize, 2 button max, progress, 429 handle
- [ ] Check Deposit: user/tx hash tools, credit duplicate nahi hota
- [ ] Settings change → cache invalidate, money setting pe PIN
- [ ] Config health sirf admin ko (users ko "missing key" kabhi nahi)
- [ ] Har button loading state, har list empty/error+Retry
- [ ] Mobile 360px par sab tabs theek
