# prompt1.md — OpalineAI (@OpalineAIBot) — Full Build Prompt for Lovable

Build a complete, production-ready **Telegram Mini App** named **OpalineAI** with bot username **@OpalineAIBot**.
OpalineAI lets users hold "crystals" (shares in an AI grid-trading bot's pool). Daily results come from the bot's **real, variable profit/loss**. Nothing is fixed or guaranteed.

Read this whole file first, then build everything, then run the **Final Verification** section at the end and fix or add anything missing.

---

## 0. Reference material (read before building)

| What | Where |
|---|---|
| UI screenshots (layout, spacing, dark green glass look) | https://github.com/mr-daaku/hosting/tree/main/OpalineAIBot/Screenshot |
| Common system and security methods | https://github.com/mr-daaku/hosting/tree/main/Common_System |

Inside Common_System, follow these files exactly where they apply: `CORE_METHODS`, `MASTER_SYSTEM_BLUEPRINT`, `auto-withdraw-deposit`, `admin_common_fircher`, `images.md`, `claudflare_lovable`. If anything in this prompt conflicts with those files on wallet, security or hosting methods, **the Common_System files win**. If a Common_System file is missing or unreadable, say so and use the method described in this prompt.

**Images:** wherever the screenshots show an image (crystals, shards, backgrounds, icons, token logos), generate it yourself and place it. Crystal images must be unique per tier (13 total), opal-like, glassy, on a dark cave or green gradient background. Use WebP, lazy load, and set explicit width/height.

---

## 1. Hard product rules (non-negotiable)

1. **No fixed returns.** Never write "daily return 3%", "guaranteed", "fixed", "risk-free", "passive income guaranteed" or similar anywhere (UI, bot messages, admin labels, DB column names shown to users).
2. **Daily result is variable.** It is entered by the admin from the AI bot's actual performance and may be positive, zero or negative.
3. **Risk disclosure** modal must be accepted (checkbox + button) before a user's first crystal purchase. Store acceptance with timestamp and version.
4. **Performance page** shows real daily results history, including negative days.
5. Shards are a **promotional reward**, funded by a capped daily promo budget (section 6). They are not an investment.
6. Referral is **Level 1 only**, one-time, and paid from platform revenue (section 8).

---

## 2. Architecture (must work on any frontend host)

**Goal:** Frontend can be hosted anywhere (Lovable, Cloudflare Pages, Vercel, Netlify) and still connect to the same backend.

- **Frontend:** React + Vite + TypeScript + Tailwind. Static build only. No server-side code in the frontend.
- **Backend:** Lovable Cloud (Supabase): Postgres, Edge Functions, Cron. All business logic lives in edge functions and Postgres RPC functions.
- **Runtime config (no rebuild needed to change backend):**
  - Frontend reads API base from `VITE_API_BASE_URL` and anon key from `VITE_SUPABASE_ANON_KEY`.
  - Also support an optional `/config.json` in `public/` that overrides them at runtime.
  - Bake a working default for the current Lovable Cloud backend into the build so the Cloudflare deploy works even if the host env vars are empty.
  - **Never show "missing key", "env not set" or similar errors to users.** If config fails, show a friendly retry screen.
- **CORS:** edge functions allow an origin allowlist from a `ALLOWED_ORIGINS` secret (comma separated), plus `*.pages.dev`, `*.lovable.app` and `localhost` for dev. Handle `OPTIONS` preflight on every function.
- **SPA routing for Cloudflare Pages:** add `public/_redirects` with `/* /index.html 200`. Include a `wrangler.toml` or short deploy notes (build command `npm run build`, output `dist`).
- **API client:** one `apiClient.ts` with base URL, auth header, timeout (10 s), 1 retry on network error, and consistent error shape. Every screen uses it.
- **Secrets (edge function secrets only, never in the frontend):** `BOT_TOKEN`, `WALLET_MNEMONIC`, `JWT_SECRET`, `ADMIN_TELEGRAM_ID`, `ADMIN_PASSWORD_HASH`, `ALLOWED_ORIGINS`, RPC URLs (BSC, ETH, TON/GRAM), explorer or indexer keys, `HOT_WALLET_*` as defined in Common_System.

---

## 3. Security and anti-abuse

- **Auth:** validate Telegram `initData` HMAC on the server on every session start; reject if older than 24 h. Issue a short-lived JWT (1 h) with refresh via initData. Never trust a user id sent by the client.
- **RLS:** enable RLS on every table with **deny all** for anon/authenticated clients. All reads and writes go through edge functions using the service role.
- **Money safety:** every balance change is a Postgres function in a single transaction that also inserts an immutable row into `ledger_entries` (user_id, type, amount, currency, ref_id, balance_after, created_at). Balances can never go below 0. Use `SELECT ... FOR UPDATE` on the user row.
- **Idempotency:** unique keys on `(chain, tx_hash, log_index)` for deposits, `(user_id, client_request_id)` for purchases/withdrawals/draws, and `(crystal_id, settlement_date)` for settlements.
- **Rate limits:** per user and per IP on draws, purchases, withdrawals, login. Return 429 with friendly message.
- **Bot detection:** on first `/start`, the bot sends a welcome message with an inline "Open App" button. A user counts as real only after the welcome message was delivered and the Mini App opened with valid initData. Bot accounts get no app access and **never** give referral credit or perk openings.
- **Self-referral and duplicate-device abuse:** block same Telegram id, and flag shared fingerprints for admin review.
- **Admin:** exactly **one fixed admin** (`ADMIN_TELEGRAM_ID`) plus password and a 6-digit TOTP. No add/remove admin feature. Admin API is separate edge functions, with their own rate limit and an audit log.
- **Fake token protection:** deposits are accepted only from a **whitelist of token contracts** (admin-visible, read-only in UI, set in code/secrets). Unknown tokens and dust are ignored and not credited.
- **UI safety:** every action button is disabled with spinner and `cursor: wait` while running (prevents double taps). Every list has loading skeleton, empty state, and error state with **Retry** button.

---

## 4. Navigation and screens

Bottom tab bar (glass style, active pill): **Home · Perks · Buy crystal · My team · My space**. Dark green/teal glass theme, as in the screenshots. English first; add a language switcher in My space (English and Hindi to start; structure i18n so more can be added).

### 4.1 Home
- Header: logo OpalineAI, mini counters (main crystals, shards), user avatar and @username, language icon.
- Hero: glowing opal crystal image. "Tap the crystal to light it up" is a cosmetic animation + haptic.
- **Shards pill** → opens Shards sheet (balance, value in USDT, accrual rate).
- **Yesterday's settlement** card: result % and USDT for the user's crystals (can be negative, shown in red). Under it: 7-day mini chart of bot results. **No ticking "live earnings" counter for crystals**, because results are not known until settlement.
- Stats row: Main crystals, Shards, Collectible shard earnings (USDT).
- **Collect shards** button: moves accrued shard earnings to Available balance (min amount configurable).
- **Daily meditation** card: user holds for 60 s once per day; this boosts shard accrual by up to +35% for 24 h (admin-configurable, counted inside the promo budget cap).
- "Project guide" link.

### 4.2 Perks (reward opening)
- Title "Open your reward", vertical/horizontal carousel of reward cards, progress "1 / 19", "Touch the crystal to open".
- Available openings counter. **1 free opening** for each new user; **+1 opening per valid invited friend** (section 8). Button "Invite a friend to unlock".
- Server-side RNG (`crypto.getRandomValues`) decides the result. The client only animates.
- Draw table (admin-editable, must sum to 100%, shown **fully and honestly** in the Project guide, and the carousel shows only real possible prizes):

| Reward | Chance |
|---|---|
| Shards ×1 | 42% |
| Shards ×2 | 27% |
| Shards ×3 | 20% |
| Shards ×4 | 6% |
| Shards ×5 | 3% |
| Shards ×6 | 1.2% |
| Shards ×7 | 0.5% |
| Shards ×8 | 0.2% |
| Shards ×9 | 0.07% |
| Shards ×10 | 0.02% |
| Surprise bonus 0.01 USDT | attached to every opening, paid from promo budget |

(Adjust the last few rows so the total is exactly 100%.)
- Result sheet: "Shards ×N — Collect shards", plus surprise bonus line.
- Reward history list (date, reward, status Collected).
- Per-friend card showing what an invite gives.

### 4.3 Buy crystal ("Crystal shop")
Stepper: 1 Choose a crystal → 2 Confirm purchase → 3 My crystals.

13 tiers (names, prices in USDT, unique art, tagline):

| # | Name | Price |
|---|---|---|
| 1 | First Crystal | 10 |
| 2 | Spark Crystal | 20 |
| 3 | Loyal Crystal | 50 |
| 4 | Soul Crystal | 100 |
| 5 | Prism Crystal | 200 |
| 6 | Light Crystal | 300 |
| 7 | Amber Crystal | 500 |
| 8 | Rainbow Crystal | 700 |
| 9 | Aurora Crystal | 1,000 |
| 10 | Tide Crystal | 1,500 |
| 11 | Solar Crystal | 2,000 |
| 12 | Nebula Crystal | 2,500 |
| 13 | Crown Crystal | 3,000 |

Cards show: image, name, tagline, price per crystal, **"Last 7-day result"** and **"Last settlement"** (real numbers from the performance table; **no daily return % promise**). Tap → Confirm sheet: price, available balance, risk summary, risk checkbox (first time), "Confirm purchase". If balance is short, show "Deposit" shortcut.

**How a crystal works (implement exactly):**
- Buying deducts price from Available balance and creates a `crystals` row: `principal`, `current_value` (starts = principal), `status=active`, `purchased_at`.
- Every day the admin enters the bot's **result %** for the date. Settlement sets `current_value = current_value × (1 + result_pct/100)` for all active crystals (same % for all tiers unless the admin enters tier-specific %, which must also be supported). `current_value` never goes below 0.
- **Collect profit:** user can move `max(0, current_value − principal)` to Available balance at any time (current_value drops back to principal).
- **Redeem crystal:** user can close a crystal after a minimum hold period (admin-configurable, default 7 days) and receive `current_value` (a redemption fee percentage is admin-configurable, default 0). Redemption is processed instantly from the platform's ledger, and the admin can pause redemptions only with a visible banner.
- Show each crystal's state in My crystals: principal, current value, profit/loss since purchase, days held.

### 4.4 My team
- Banner "Invited by <inviter name>" (if any).
- Card: "For each invited friend → Open once for free" and "Level 1 referral bonus (X%)", X read from settings.
- **Your invitation link:** `https://t.me/OpalineAIBot?start=ref_<CODE>` with **Share invitation** (Telegram share sheet) and **Copy link**.
- Team earnings: **Level 1 only** (people invited, total bonus earned, this-month bonus). List of Level 1 members with name, join date, and whether they bought a crystal. Empty state "Your first teammate awaits".

### 4.5 My space
- Profile (avatar letter, @username), Available balance (USDT), Main crystals, Shards, Settled earnings.
- **Deposit** and **Withdraw** buttons.
- Menu: My crystals, Crystal records (settlement history per crystal), Crystal orders (purchases/redemptions), My team, Project guide, Language.
- Transactions history (deposits, withdrawals with status chips).

### 4.6 Project guide (accordion)
Sections: How crystals work (variable results, risks), Earnings formula, Draw probabilities (full table), Shards, Referral, Deposits and withdrawals (networks, fees, times), FAQ, Risk disclosure, Terms. Use plain language, **no promise wording**.

### 4.7 Performance page (linked from Home and Buy crystal)
Table and bar chart of daily results (date, result %, note), 7/30-day totals, best/worst day. Data comes only from admin's settlement entries.

---

## 5. Wallets: deposit address by index (HD wallet)

Follow `auto-withdraw-deposit` from Common_System. Summary of the required method:

- A single secret **`WALLET_MNEMONIC`** in edge-function secrets. It is never stored in the DB, logs or frontend.
- **Each user gets a permanent `wallet_index`** (integer) assigned once, atomically, from a Postgres sequence at first login.
- **Addresses are derived on demand** from mnemonic + `wallet_index`. Do not store private keys. Do not store addresses in the DB; if a lookup cache is needed for scan speed, keep **public addresses only** in memory or a KV cache rebuilt from `0..max_index`.
  - **EVM (BEP20 and ERC20):** BIP-44 path `m/44'/60'/0'/0/{wallet_index}`. The same `0x…` address is used on BNB Smart Chain and Ethereum.
  - **GRAM network:** derive from the same mnemonic and index with the method defined in Common_System (TON-style address, ed25519). If Common_System does not define it, use SLIP-0010 ed25519 path `m/44'/607'/{wallet_index}'`.
- Deposit screen: asset/network selector, QR code, address, **Copy** button, min deposit, confirmations needed, and a warning "Send only the selected asset on the selected network".

### Deposit assets

| Asset | Networks |
|---|---|
| USDT | BEP20 (BNB Smart Chain), ERC20 (Ethereum), GRAM |
| USDC | BEP20, ERC20, GRAM (hide any combination whose token contract is not configured) |
| BNB | BNB Smart Chain (native) |
| ETH | Ethereum (native) |
| GRAM | GRAM network (native) |

### Detection and crediting
- A scanner (cron every 30–60 s plus a "I've paid" refresh button that triggers an immediate check for that user) reads new transfers to derived addresses, per chain.
- Credit only after required confirmations (admin-visible defaults: BSC 15, ETH 12, GRAM as per Common_System).
- Credit rules: USDT/USDC 1:1 to the USDT balance; native BNB/ETH/GRAM converted to USDT at the price at credit time (cached price from a reliable source with 60 s cache and a sanity band; store the rate used in the ledger row).
- Ignore unknown tokens, fake tokens, below-minimum dust, and failed transactions.
- **Sweeper:** a queued job moves funds from user addresses to the treasury/hot wallet, topping up gas only when needed and in batches. Failures retry with backoff and are shown in Admin.

---

## 6. Shards (promo rewards)

- New user gets **50 shards** on first open ("First-entry gift"), admin-configurable.
- **1 shard = 0.005 USDT** (config). Shard earnings accrue at an **admin-set promo rate per day** (default 3% of shard value, label it "Promo rate", not "return"), plus the meditation boost.
- **Daily promo budget cap** (`promo_budget_daily_usdt`, admin-set): if total accrual for the day would exceed the cap, scale all accruals down proportionally and show "Promo budget reached" on Home.
- Promo earnings (shard accrual and surprise bonuses) become withdrawable only after the user has bought at least one crystal (config flag, default on).
- Accrual is computed deterministically from timestamps (no per-second DB writes). The Home counter animates client-side from `last_accrual_at`.
- Shards ledger is separate from the USDT ledger; "Collect shards" converts accrued value to Available balance.

---

## 7. Withdraw

**Withdraw networks (only):** **BEP20-USDT** and **GRAM-USDT**.

Flow:
1. Select network → enter address (validate format and checksum per chain) → enter amount (min, max, daily limit, fee shown from settings).
2. **Review withdrawal** sheet: asset, address, amount, fee, net amount. Text: "Check the network, address and amount. Submitting a request does not mean funds have arrived."
3. **Submit withdrawal request:** funds are locked immediately (ledger entry), status `pending`.
4. Processing per `auto-withdraw-deposit` using a **queue**: small amounts auto-pay, amounts above an admin threshold wait for admin approval. Statuses: `pending → processing → sent (tx hash) / failed (auto-refund) / rejected (refund with reason)`.
5. Telegram bot message on each status change; tx hash with explorer link.
- Safeguards: one active withdrawal per user (configurable), cooldown after address change, per-user and global daily caps, treasury balance check before sending, double-send prevention using the idempotency key.

---

## 8. Referral (Level 1 only)

- Each user has a unique code. Deep link `start=ref_<CODE>` is stored at the first `/start` only (cannot be changed later).
- Referral becomes **valid** when the invited user is a real (non-bot) user who opened the app.
- Rewards for the inviter:
  - **+1 Perks opening** per valid invited friend (once per friend).
  - **One-time bonus** = `referral_bonus_percent` (default 5%, admin-set) of the friend's **first crystal purchase**, credited to the inviter's Available balance right after a successful purchase, paid from platform revenue. No multi-level, and no share of the friend's daily results.
- Show clearly in UI how much is earned. Self-referral, bot accounts and flagged duplicates earn nothing.

---

## 9. Telegram bot (@OpalineAIBot)

- `/start`: welcome message (with the user's name) and inline button **Open OpalineAI** (Mini App). This message also serves as bot detection.
- Handle `start=ref_<CODE>`.
- Notifications: deposit detected/confirmed, crystal purchased, daily settlement posted (with the result %), withdrawal status changes, referral joined/bonus received.
- Webhook handler is an edge function that verifies the Telegram secret token header.
- Set the Mini App menu button and short description via a one-time setup function.

---

## 10. Admin panel (single admin, separate route `/admin`)

Auth: Telegram id match + password + TOTP. Session timeout 30 min. Everything audit-logged.

| Page | Features |
|---|---|
| Dashboard | Users, deposits, withdrawals, crystals value, pool value, today's promo budget used, treasury balances per chain |
| **Daily settlement** | Pick a date, enter result % (or per-tier %), see a **preview of total impact (sum of gains/losses)**, confirm. One entry per date. Corrections are new "adjustment" entries, never edits. Optional note shown on the Performance page |
| Users | Search, balances, crystals, ledger, ban/unban, flags |
| Deposits | Per chain list, stuck/unmatched transfers, sweeper status |
| Withdrawals | Queue, approve/reject/retry, tx hash, auto-pay threshold |
| Crystals | View counts per tier, redemption pause with banner |
| Promo and Perks | Shard value, promo rate, daily budget, meditation boost, draw table (validated to sum to 100%), openings |
| Referral | Bonus %, valid referrals, fraud flags |
| Settings | Min/max deposit and withdraw, fees, confirmations, minimum hold days, redemption fee, maintenance mode |
| Content | Project guide text, risk disclosure text and version, Performance notes |
| Broadcast | Send a bot message to all or selected users, with rate-limited sending |
| Audit log | Immutable list of admin actions |

---

## 11. Database (minimum tables)

`users` (id, telegram_id unique, username, name, wallet_index unique, referrer_id, ref_code, is_bot_flag, risk_accepted_at/version, created_at, banned) ·
`balances` (user_id, usdt_available, shards, shard_accrued_usdt, last_accrual_at) ·
`ledger_entries` (immutable) ·
`crystal_tiers` (id, name, tagline, price, image_url, sort) ·
`crystals` (id, user_id, tier_id, principal, current_value, status, purchased_at, closed_at) ·
`daily_results` (date unique, result_pct, tier_overrides json, note, created_at) ·
`crystal_settlements` (crystal_id, date, pct, delta, unique(crystal_id,date)) ·
`deposits` (chain, token, tx_hash, log_index, user_id, amount, usd_value, rate, confirmations, status, unique(chain, tx_hash, log_index)) ·
`withdrawals` (id, user_id, network, address, amount, fee, status, tx_hash, client_request_id, created_at) ·
`perk_openings` (user_id, available) and `perk_history` (id, user_id, reward_type, shards, bonus_usdt, created_at) ·
`referrals` (inviter_id, invited_id unique, valid, opening_granted, bonus_paid) ·
`promo_budget_days` (date, cap, used) ·
`settings` (key, value) ·
`admin_audit` (id, action, payload, created_at) ·
`rate_limits` and `webhook_events` (for idempotent bot updates).

Add indexes on every foreign key and on `(status, created_at)` for queues.

---

## 12. Speed and UX

- Code-split by route; lazy load heavy sheets and charts; target first load under 150 KB JS gzipped for the main bundle.
- One bootstrap call `/api/bootstrap` returns profile, balances, crystal summary, last result and settings (cached with `stale-while-revalidate`). Use React Query with sensible stale times.
- Skeleton loaders everywhere; no blank screens. Optimistic UI only for harmless actions (copy, tab switch), never for money.
- Preload the next tab's data, WebP images with `loading="lazy"`, small SVG icons, reduced-motion support.
- Haptic feedback via Telegram WebApp API on taps, draws and success. Use Telegram theme-safe areas and `Telegram.WebApp.expand()`, handle the back button.
- Make the cron jobs and queues batch-based and idempotent so they stay fast with many users.

---

## 13. Final Verification (do this after building)

Go through this list item by item. Test it, fix what fails, and **add anything that is missing**. Then reply with a short report of what you checked, what you fixed and what you added.

- [ ] No screen, bot message or admin label contains "fixed", "guaranteed", "risk-free" or a daily-return promise.
- [ ] Risk disclosure is required before the first purchase; Performance page shows negative days.
- [ ] Settlement preview and apply work, are idempotent per date, and negative results reduce crystal value (never below 0).
- [ ] Crystal purchase, collect profit and redeem (after minimum hold) all update the ledger correctly; balances never go negative.
- [ ] Each user gets a unique `wallet_index`; EVM address works for BEP20 and ERC20; GRAM address is derived; no private keys or mnemonic in DB, logs or frontend.
- [ ] Deposits: USDT/USDC on BEP20, ERC20 and GRAM, native BNB, ETH, GRAM; unknown/fake tokens ignored; confirmations enforced; duplicate tx hash cannot credit twice.
- [ ] Withdraw only BEP20-USDT and GRAM-USDT; address validation, review sheet text, queue, auto-refund on failure, admin approval threshold.
- [ ] Perks draw: server-side RNG, probabilities sum to 100%, openings only from free first opening and valid invites.
- [ ] Shards accrue within the daily promo budget cap; promo earnings withdrawable only after the first crystal purchase.
- [ ] Referral is Level 1 only, one-time, bots and self-referrals get nothing.
- [ ] Telegram initData validated server-side; RLS deny-all; admin has Telegram id + password + TOTP; no add/remove admin.
- [ ] All action buttons show loading and are disabled during the action; every list has empty and error states with Retry.
- [ ] Frontend builds as static files and works on Cloudflare Pages with only `VITE_API_BASE_URL` / `VITE_SUPABASE_ANON_KEY` (or `config.json`); CORS preflight passes; SPA routes work after refresh (`_redirects`).
- [ ] No "missing key" or env error is ever visible to users.
- [ ] All images are generated and loaded (13 crystal tiers, shard, backgrounds, token and network icons); performance is smooth on a mid-range phone.
- [ ] Common_System rules were applied; anything not covered there is listed in your report.
