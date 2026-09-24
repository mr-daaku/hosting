# OminiAi — Telegram Mini App (HD Wallet + Coin/USDT Earning System)

Bot name: **OminiAi**
Bot username: **@OminixAiBot**

Build a Telegram Mini App (React + Vite + TypeScript + Supabase + Cloudflare Workers) where every user gets their own **per-chain HD-derived deposit address** (index-based), can deposit crypto, receives coins for deposits, earns a daily USDT-equivalent yield on their coin balance, sees a simulated AI trading demo, and can be fully managed from an admin panel.

---

## 1. Tech Stack

- Frontend: React + Vite + TypeScript, TanStack Router/Query
- Backend/DB: Supabase (Postgres + Row Level Security)
- Serverless jobs / RPC calls: Cloudflare Workers
- Telegram: Bot API via webhook (not polling)
- Wallet derivation: BIP39 mnemonic → per-chain HD paths (see §3)

---

## 2. Core Economy Rules

- **Welcome bonus:** every new account starts with **100 coins**.
- **Deposit → coin conversion:** `coins_credited = deposit_usd_value * 100` (e.g. $1 deposit = 100 coins).
- **Daily coin yield:** every user's *coin balance* generates **0.02% of that balance in USDT** per day (e.g. 1000 coins → 0.2 USDT/day). This accrues to the user's USDT balance, claimable via a "Claim profit" action (matches reference screenshots: hourly/daily/monthly projected income display + Claim button).
- **Random gift:** users can open a "Gift" claiming **1–10 coins at random** (admin sets frequency/cooldown, e.g. once per invite or once per day — make this admin-configurable).
- **Referral rewards:** see §7.
- Both **coin balance** and **USDT balance** are tracked separately per user and must be admin-editable independently.

All numeric constants above (welcome bonus, conversion rate, daily yield %, gift range, referral coin/bonus %, min deposit, min withdrawal, withdrawal fee) must live in an `app_settings` table, not hardcoded, and must be editable from the Admin → Settings tab.

### Coin / brand imagery
Wherever a coin balance, coin icon, or coin amount is shown anywhere in the app (balance cards, transaction history, gift popup, referral rewards, admin panel), use a **real coin logo image pulled from the internet** (not an emoji, not a generated SVG placeholder) — consistent, professional-looking token art throughout.

---

## 3. HD Wallet System

A single 12-word BIP39 mnemonic is stored server-side only (`MNEMONIC` secret, see §12). Each user gets a unique, sequential **wallet index** assigned at account creation (0, 1, 2, 3…). From that one mnemonic + index, derive:

| Chain | Path | Notes |
|---|---|---|
| EVM (ETH / BSC / Polygon — one address covers all) | `m/44'/60'/0'/0/{index}` | via `ethers.HDNodeWallet.fromPhrase` |
| Tron | `m/44'/195'/0'/0/{index}` | derive EVM-style key, encode with `TronWeb.address.fromPrivateKey` |
| Solana | `m/44'/501'/{index}'/0'` | via `ed25519-hd-key` `derivePath` + `Keypair.fromSeed` |
| TON | **not derived** — fixed shared address for all users | `UQCVxhjBVJQ7ufjD1lLSZW967R1DrFvFuOtVhsECnU_lqArV`, memo `OMA-{userid}` distinguishes users |

Reference derivation logic (already written, port this server-side, never expose private keys to the client):

```ts
function getEvmAddress(mnemonic: string, index: number): string {
  const path = `m/44'/60'/0'/0/${index}`;
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path).address;
}

function getSolanaAddress(mnemonic: string, index: number): string {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed.toString("hex"));
  return Keypair.fromSeed(Uint8Array.from(key)).publicKey.toBase58();
}

function getTronAddress(mnemonic: string, index: number): string {
  const path = `m/44'/195'/0'/0/${index}`;
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
  return TronWeb.address.fromPrivateKey(wallet.privateKey.slice(2));
}
```

Generate and store all 4 addresses (EVM, Tron, Solana, TON+memo) for a user **once**, at account creation, in the `wallets` table — never regenerate on the fly.

---

## 4. Supported Chains / Coins for Deposit

User flow: **Select Chain → Select native or stablecoin → Deposit page (QR + address [+ memo for TON] + "Check Deposit" button + "Open App" button)**

| Chain | Native | Stablecoin(s) |
|---|---|---|
| Ethereum (ERC20) | ETH | USDT-ERC20, USDC-ERC20 |
| BNB Chain (BEP20) | BNB | USDT-BEP20, USDC-BEP20 |
| Polygon | MATIC | USDT (Polygon) |
| Tron | TRX | USDT-TRC20 |
| Solana | SOL | USDT-SOL |
| TON | TON | USDT-TON |

Deposit page must show:
1. QR code of the address (+memo for TON)
2. Address (copy button), and Memo field for TON (copy button)
3. "Check Deposit" button → triggers on-chain check
4. "Open App" button → returns user to the mini app home
5. Coin logo (see §2) shown next to the selected coin, sourced from the internet

---

## 5. Deposit Detection (public RPC / explorer APIs — no paid indexer)

Use free/public APIs per chain, polled server-side (Cloudflare Worker cron, every 1–2 min) **and** on-demand when the user taps "Check Deposit":

| Chain | API to use |
|---|---|
| ETH / BSC / Polygon | Etherscan/BscScan/Polygonscan public API (`?module=account&action=tokentx` / `txlist`) — free API key |
| Tron | TronGrid public API (`/v1/accounts/{address}/transactions/trc20`) |
| Solana | Public Solana RPC `getSignaturesForAddress` + `getTransaction` |
| TON | TonAPI v2 public endpoint, filter incoming transactions by memo `OMA-{userid}` |

**Logic (all chains):**
1. Fetch latest incoming transactions for the user's address (or, for TON, the shared address filtered by memo).
2. For each tx not already present in the `deposits` table (dedupe by tx hash), insert a new `deposits` row with status `confirmed` once it has sufficient confirmations.
3. On insert, credit the user's **coin balance** by `usd_value * 100` and increment `total_deposit`.
4. If the depositing user was referred, also apply the referral deposit bonus (§7) to the referrer.
5. USD value: fetch live price via a free price API (e.g. CoinGecko public API) at time of credit.
6. "Check Deposit" button on the frontend just re-triggers this check for that one user/address and shows a toast (credited / still pending / not found).

---

## 6. Withdrawal

- User requests withdrawal of USDT or coin-converted value to a chain + address they provide.
- Admin reviews and approves/rejects (manual payout, mark tx hash) — mirror the reviewed-withdrawal pattern: on approval, deduct balance + increment `total_withdrawal`; on rejection, optionally refund.
- Minimum withdrawal, withdrawal fee (flat or %) — both in `app_settings`, admin-editable.
- Every withdrawal request has a lifecycle status: `pending` → `paid` or `rejected` (drives the admin Withdrawals tab, §11).

---

## 7. Referral System

- Referral link format: `https://t.me/OminixAiBot/ai?startapp={userid}`
- Reward for inviting a friend:
  - **+10 coins** to the referrer, credited when the invited friend opens the app for the first time (account creation).
  - **+5% deposit bonus** to the referrer on every deposit the invited friend makes, for as long as they're referred (e.g. friend deposits $10 → referrer additionally gets 5% of that deposit's coin value credited).
- `referred_by` is set once at account creation from `startapp` and never changes.
- A referral only counts, and only pays out, if the invited account passes the one-device-one-account check in §8 — a banned duplicate account must not trigger referral rewards.
- Admin can view/edit referral coin amount and referral deposit bonus % in Settings (already covered by the `app_settings` rule in §2).

---

## 8. Anti-Multi-Account (Device Fingerprint)

- On every app open, collect a **device fingerprint** (client-side, e.g. via a fingerprinting library such as FingerprintJS — combination of device/browser signals available inside the Telegram WebView) and send it to the backend alongside the Telegram user ID.
- Store fingerprint → `user_id` mapping in a `device_fingerprints` table.
- If a **new** Telegram account opens the app from a fingerprint that's already linked to an existing account, **automatically ban** the new (second) account (`is_banned = true`, reason = "duplicate device") and block it from earning, depositing, withdrawing, or claiming referral/gift rewards. The first/original account on that device is untouched.
- Admin can see the linked fingerprint and any other accounts sharing it on the Users tab, and can manually unban a false positive.

---

## 9. AI Trading Demo

A visual-only simulated trading feature (no real trades, no real funds at risk) to make the app feel like an active AI trading bot:

- Show a live-looking trade feed: random buy/sell entries on a rotating set of pairs (e.g. BTC/USDT, ETH/USDT, SOL/USDT), random small P&L per trade, timestamps ticking in real time.
- Display an overall **"Success rate: 70%+"** stat (admin-editable target range, e.g. 70–85%, randomized within that band).
- Include a simulated chat/log panel that reads like a real AI trading assistant narrating its own decisions (e.g. "Analyzing BTC/USDT momentum…", "Entered long position…", "Took profit at +2.3%") — text is templated/randomized, not a real LLM call, so it's cheap and can't leak anything.
- Use the demo images from this GitHub folder for chart/branding visuals in this section: `https://github.com/mr-daaku/hosting/tree/main/OminiAiBot/Image` (fetch the raw file URLs from that folder).
- All of this is purely cosmetic — it must never move real coin/USDT balances. Clearly label it as an AI trading preview/demo if needed for compliance, but keep the visual presentation confident and polished (this is a growth/engagement feature).

---

## 10. Account Creation (on first Mini App open)

On first launch, run the device-fingerprint check (§8) first, then create a row in `users` with:

- `wallet_index` (next sequential index)
- `name` (from Telegram profile)
- `username` (Telegram @username, or "no-username" if absent)
- `tg_user_id`
- `device_fingerprint`
- `coin_balance` = 100 (welcome bonus)
- `usdt_balance` = 0
- `total_deposit` = 0
- `total_withdrawal` = 0
- `joined_at`
- `is_banned` = false
- `evm_address`, `tron_address`, `solana_address`, `ton_memo` (from §3)
- `referred_by` (from `startapp` param, if present)

If the fingerprint is already linked to another account, still create the row but immediately set `is_banned = true`, `ban_reason = "duplicate device"`, and skip the welcome bonus + referral payout.

---

## 11. Admin Panel

**Dashboard:** total users, total deposits (USD), total withdrawals (USD), total coins in circulation, banned users count, online/active users, daily new users, pending withdrawals count (badge).

**Users tab:**
- Search bar — search by Telegram user ID (and ideally username/name too)
- On selecting a user, show and allow editing:
  - Ban / Unban (with ban reason shown, e.g. manual vs duplicate-device)
  - Add/remove coin balance
  - Add/remove USDT balance
  - Wallet index, name, username, Telegram ID (read-only)
  - Joined date
  - Total deposit, total withdrawal (read-only, computed)
  - Per-chain deposit addresses (read-only, for support lookups)
  - Linked device fingerprint + any other accounts sharing it
  - Referral stats: who referred them, how many they've referred, total referral earnings

**Withdrawals tab** — 3 sub-tabs:
- **Pending** — list of open withdrawal requests (user, amount, chain, destination address, requested time) with Approve/Reject actions; Approve lets admin attach a tx hash, Reject optionally refunds the user.
- **Paid** — approved/completed withdrawals, with tx hash shown (linkable to a block explorer).
- **Rejected** — declined withdrawals, with reason.

**Deposits tab:**
- List of all successfully confirmed deposits: user, chain, coin, amount, USD value, coins credited, tx hash (linkable to explorer), timestamp. Searchable/filterable by user ID.

**Broadcast tab:**
- Send to a single user (by Telegram ID) or all users
- HTML formatting supported
- Optional image URL
- Optional inline keyboard buttons (label + URL), multiple buttons supported

**Settings tab** — every user-facing economic constant, editable:
- Welcome bonus amount
- Deposit→coin conversion rate (currently 100x)
- Daily coin yield % (currently 0.02%)
- Gift random range (currently 1–10 coins)
- Referral coin reward (currently 10) and referral deposit bonus % (currently 5%)
- AI trading demo success-rate range (currently 70%+)
- Min deposit / min withdrawal
- Withdrawal fee (flat or %, toggle)
- TON deposit address + memo prefix (currently `OMA-`)
- Admin Telegram IDs list (who can access the admin panel)

---

## 12. Environment Variables / Secrets

Tell the app to read these two secrets — you'll enter the actual values when deploying:

| Secret name | What goes in it |
|---|---|
| `BOT_TOKEN` | Your Telegram bot token from @BotFather for **@OminixAiBot** |
| `MNEMONIC` | Your 12-word BIP39 wallet seed phrase, space-separated, e.g. `word1 word2 ... word12` — this is what all EVM/Tron/Solana deposit addresses are derived from. Never expose this to the frontend; it must only be readable server-side (Supabase Edge Function / Cloudflare Worker secret). |

The TON address (`UQCVxhjBVJQ7ufjD1lLSZW967R1DrFvFuOtVhsECnU_lqArV`) is fixed and not derived from the mnemonic — store it as a plain admin-editable setting, not a secret.

---

## 13. Bot Behavior

- Webhook-based `/start` handler: runs the device-fingerprint-aware account creation if new (see §8, §10), and replies with:
  - A **welcome image generated by Lovable AI itself** (not a static uploaded file) — an on-brand welcome/banner graphic for OminiAi.
  - A welcome caption/message.
  - An "Open App" inline button, deep-linking to `https://t.me/OminixAiBot/ai?startapp={userid}` so the link carries the referral code (see §7).
- Admin broadcast messages are sent through the same bot via the Bot API `sendMessage`/`sendPhoto` with `parse_mode: HTML` and `reply_markup.inline_keyboard`.

---

## 14. Data Model (Supabase tables, minimum)

- `users` — see §10 fields
- `wallets` — user_id, chain, address, memo (nullable), index
- `device_fingerprints` — fingerprint, user_id, first_seen_at
- `deposits` — id, user_id, chain, tx_hash (unique), amount, usd_value, coins_credited, status, created_at
- `withdrawals` — id, user_id, chain, address, amount, fee, status (`pending`/`paid`/`rejected`), tx_hash, reject_reason, created_at, reviewed_by
- `referrals` — referrer_id, referred_id, signup_bonus_paid, total_deposit_bonus_earned
- `app_settings` — key/value store for all admin-customizable constants (§2, §7, §9, §11)
- `admins` — tg_user_id list with access
- `broadcasts` — log of sent broadcasts (optional, for history)

---

## 15. Non-negotiables

- Never regenerate a user's addresses after first creation.
- Never expose the mnemonic or any derived private key to the client.
- Every balance change (deposit credit, daily yield claim, gift, referral reward, admin adjustment, withdrawal debit) must be a logged, auditable transaction, not a silent balance overwrite.
- Deduplicate deposits strictly by on-chain tx hash so "Check Deposit" can be tapped repeatedly without double-crediting.
- The AI Trading Demo must never touch real balances — it's presentation only.
- A device-fingerprint-banned duplicate account must never receive welcome bonus, gifts, yield, or referral payouts.
