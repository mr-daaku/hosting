# MagiqAi — Prompt 1 (full build, v2: coin→chain deposits, auto on/off, full OminiAi admin, code samples)

> Read this whole file before writing code. Do the work in the order given. Where this file and an old habit disagree, this file wins.

## 0. FIRST: save memory in AGENTS.md

Before coding, create/update `AGENTS.md` (project root) with the rules below, so you remember them in every later prompt. Keep each as a short line with a "Why".

- Project: **MagiqAi**, Telegram Mini App, bot **@MagiqAiBot**. Fantasy mage game; users buy mages that earn gems every day; crypto deposits/withdrawals; referral program; full admin panel.
- Architecture = **exactly the OminiAi method** (`ominiaibot-main`): TanStack Start `createServerFn` server functions, Supabase (service-role only on the server, RLS on, no client table access), Cloudflare Workers hosting, Telegram webhook, `/admin` inside the same app. The code samples in sections 12–17 of this file are the reference implementation; copy their structure, do not invent a new one.
- Security source of truth: `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/security.md`. Re-read it before every feature that touches auth, money, admin, logs or data collection.
- Design reference assets: `https://github.com/mr-daaku/hosting/tree/main/MagiqAiBot/images` (raw base `https://raw.githubusercontent.com/mr-daaku/hosting/main/MagiqAiBot/images/`).
- `style.css` / global CSS must always contain (never remove):
  ```css
  #lovable-badge { display: none !important; }
  .safe-bottom { padding-bottom: calc(max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)) + 0.75rem); }
  ```
- Deposit UX rule: **select coin → select chain → deposit page**. If the coin exists on only ONE chain (native coin: GRAM, BNB, ETH) skip the chain step and go straight to the deposit page.
- On/off switches that must exist in admin (all stored in `app_settings`, "on"/"off"): `deposits_open`, `auto_deposit`, per-coin and per-chain deposit toggles, `withdrawals_open`, `withdraw_bep20_open`, `withdraw_gram_open`, `autopay_enabled`, `autopay_bep20`, `autopay_gram`.
- Money rules: all balance changes via atomic SQL functions + append-only ledger; deposits deduped by `(tx_hash, asset)`; withdrawal row locked `pending → processing → paid/rejected` so it can never be paid twice; banned accounts are never paid.
- Prices: browser first (Binance), server fallback Coinbase → OKX → CoinGecko (cloud IPs get blocked by Binance/CoinGecko).
- Deposit addresses: EVM per-user address derived on the fly from `MNEMONIC` + `wallet_index` (never stored); GRAM = one shared address + memo `MAG-<telegram id>`.
- Secrets live only in server env: `BOT_TOKEN, MNEMONIC, PAY_WALLET_SECRET, TON_WALLET_SECRET, ETH_API, BSC_API, TON_API_KEY, PAY_TONCENTER_API, ADMIN_TG_ID, SUPABASE_SERVICE_ROLE_KEY`. Never hardcode wallet addresses, never log secrets.
- Prompt links: when the user sends just "Hii", open the next prompt file (last was promptN → read promptN+1 at `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/`); if missing, read the highest-numbered prompt there.
- Security rules (section 9): one account per device, banned IP, bot/fake-account heuristics, rate limits.
- Keep `roadmap.md` updated and tick each feature when done.

---

## 1. Product identity

- App name: **MagiqAi** · Bot: **@MagiqAiBot** · Default language EN (also RU, ZH, AR with RTL, same i18n setup as OminiAi).
- Main currency: **Gems** (orange crystal icon). Secondary resource: **Magic** (blue orb icon).
- Telegram `/start` only sends a welcome message (image + "Open MagiqAi" web-app button). Nothing else (same as OminiAi Prompt16).

## 2. Design reference (copy the LOOK and LAYOUT)

Reference screenshots (another app, named "Mag IA") are in the images folder. Use them for **layout, structure, mood, spacing**. App logo: `MagiqAi.png` (use as app icon, loading screen, favicon, welcome image).

| Screenshot file (start of name) | Screen |
|---|---|
| `Screenshot_2026-10-02-17-04-53` | Magician tab (home) |
| `Screenshot_2026-10-02-17-04-57` | Magic packs + start of mage shop |
| `Screenshot_2026-10-02-17-05-04` | Mage shop (owned mage with ×1 badge) |
| `Screenshot_2026-10-02-17-05-16` | Mage shop bottom (top-tier mages) |
| `Screenshot_2026-10-02-17-05-20` | Deposit tab + promo popup |
| `Screenshot_2026-10-02-17-05-25` | Withdraw tab |
| `Screenshot_2026-10-02-17-05-33` | Partners tab |
| `Screenshot_2026-10-02-17-05-36` | Profile |
| `Screenshot_2026-10-02-19-10-46` | "Choose a coin" modal |
| `Screenshot_2026-10-02-19-10-49` | Deposit form |

Rules:
- Match the structure and feel, but ship **our own** logo and **our own mage artwork**. Do not hotlink or copy the reference app's character art. If the owner has added an example character image to the images folder, use its style for all 12 mages (same pose size, same lighting, transparent PNG). If none exists, generate 12 original mage illustrations in that style and keep them in `src/assets/mages/mage-01.png … mage-12.png`.
- Visual style: dark enchanted wizard-library background (candles, books, crystal ball, night window), **stone/parchment cards** with subtle cracks and rounded corners, soft inner shadow, chunky 3D stone buttons (grey, pressed effect), green stone pill tabs, active tab = purple/blue glowing pill. Fantasy display font for headings/numbers (loaded locally or via Google Fonts with a fallback), readable on mobile.
- Locked (not owned) mages are shown as **grey silhouettes**; owned mages in full colour with a blue `×N` badge.
- Respect Telegram safe areas (`.safe-bottom`, top safe inset), fullscreen mode, no horizontal scroll, works at 360px width.
- Language switcher: small pill bottom-left (flag + code + chevron), opens upward.

## 3. Screens
### 3.1 Header (all tabs)
- Left: stone card "My balance" + gem icon + number.
- Centre: round avatar (Telegram photo is only **displayed from the Telegram client, never stored**).
- Right: green "Profile" button.
- Below: 4 pill tabs — **Magician · Deposit · Withdraw · Partners**.
### 3.2 Magician (home)
1. "Daily income" row with total gems/day (sum of owned mages) and a thin progress bar.
2. Big card: currently selected mage, a level/count pill ("1"), accumulated gems counter (4 decimals, ticking live), and a **COLLECT** button (min collect configurable).
3. 3×4 grid of 12 mage slots (small cards, owned = coloured, locked = silhouette with "0"). Tapping a slot selects it for the big card.
4. "Magic" row with current Magic amount (blue orb).
5. Banner card: "Your mages are resting — they need magic" + **Buy magic** button (show only when Magic = 0; otherwise show remaining time).
6. Magic packs (3 cards): **+500 Magic = 100 gems**, **+5,000 = 1,000 gems**, **+25,000 = 5,000 gems**.
7. Mage shop (2-column grid, 12 cards). Each card: artwork, "Daily income N%", "+X gems/day", price button in gems. Stackable (buying again increases ×N).

Mage shop defaults (all editable in admin):

| # | Price | Daily % | Gems/day | Note |
|---|---|---|---|---|
| 1 | 10 | 20% | +2 | from screenshot |
| 2 | 25 | 20% | +5 | from screenshot |
| 3 | 50 | 22% | +11 | placeholder (not visible in screenshots) |
| 4 | 100 | 22% | +22 | placeholder |
| 5 | 250 | 24% | +60 | placeholder |
| 6 | 500 | 24% | +120 | placeholder |
| 7 | 1,000 | 26% | +260 | from screenshot |
| 8 | 2,500 | 26% | +650 | from screenshot |
| 9 | 5,000 | 28% | +1,400 | from screenshot |
| 10 | 10,000 | 28% | +2,800 | from screenshot |
| 11 | 25,000 | 30% | +7,500 | from screenshot |
| 12 | 50,000 | 30% | +15,000 | from screenshot |

Mechanic (assumption — keep configurable): mages only produce while the user has Magic > 0; Magic is consumed over time (setting `magic_burn_per_gem_earned`, default 1). When Magic = 0 mages "rest" and show the resting banner. Accrual is computed **on the server from timestamps** (no per-second DB writes): `earned = rate_per_sec × min(elapsed, magic_covered_time)`.
### 3.3 Deposit (3 steps: coin → chain → deposit page)

Route `/deposit` with search params `?coin=USDT&chain=bsc` (same pattern as OminiAi's `/deposit?chain=..&asset=..`, but coin first).

1. **Step 1 – Choose a coin** (stone modal/list like the reference "Choose a coin": logo, name, live USD price). Coins: **GRAM, USDT, BNB, ETH, USDC**. Admin can switch any coin off.
2. **Step 2 – Choose a chain** (only if the coin exists on more than one chain):
   - USDT → **BNB Chain (BEP20)**, **GRAM**, **Ethereum (ERC20)**
   - USDC → **BNB Chain (BEP20)**, **Ethereum (ERC20)**
   - **Native coins skip this step and open the deposit page directly:** GRAM → GRAM chain, BNB → BNB Chain, ETH → Ethereum.
3. **Step 3 – Deposit page**: QR code, address (copy button), **memo box for GRAM chain** (`MAG-<telegram id>`, with a big warning "memo is mandatory"), live rate for non-stable coins ("1 GRAM = X USDT = Y gems", minimum deposit in that coin, "updated hh:mm"), warning "send only <coin> on <chain>", amount calculator ("$1 → 5,000 gems"), **Check deposit** button (1 call / 10 s), **Open wallet** deep link (Tonkeeper for GRAM, Trust Wallet for EVM), and the deposit history table (Date · Method · Sum · Status).
4. Back button on each step goes one step up (page → chain → coin).
5. If `deposits_open = off`, or the selected coin/chain is switched off, show a stone pop-up "Deposits are temporarily closed" instead of the address.

Auto-credit: a cron endpoint scans for new deposits every minute (`auto_deposit = on`), and the **Check deposit** button scans on demand even when `auto_deposit = off`. Code in section 13.

Rates: **$1 = 5,000 gems** (admin), minimum deposit **$1** (admin). Promo popup (✕) is admin-editable; default text must be neutral: "Top up with GRAM or USDT. Mage earnings are estimates and are not guaranteed." No "safe/trusted/guaranteed/start investing" wording.

### 3.4 Withdraw

- Two method cards (like the reference): **USDT BEP20** and **USDT GRAM**. Each shows **Minimum (gems): 10,000** and **Minimum (USD): $1.00** (fix the reference's duplicated "Minimum" label). A method that admin switched off shows "Not available".
- If `withdrawals_open = off`: full-screen stone pop-up "Withdrawals are closed — your balance is safe" (4 languages).
- Form: available gems, pending/frozen gems, amount in gems with **MAX**, live line "= $X USDT · fee · you receive", address input (`0x…` or `UQ…/EQ…`), submit.
- Rates: **10,000 gems = $1** (admin setting, separate from the deposit rate).
- Rules (all server-side, code in section 14): minimum amount, 24 h between withdrawals, first withdrawal only after `min_account_age_hours`, free cap for users without a deposit, fee flat/percent, banned = restricted.
- After submit: bot DM to the user, bot alert with buttons to every admin, then **autopay** if the admin enabled it and all limits pass; otherwise the request waits in the admin Withdrawals tab.
- History table: Date · Method · Sum · Status (pending / processing / paid / rejected) with explorer link for the tx hash.
### 3.5 Partners
- Top card: referral earnings pending (gem icon + number) with **Collect** button; referral link `https://t.me/MagiqAiBot/<MINIAPP_SHORT_NAME>?startapp=<telegram id>` with **Copy** button.
- Three info tiles: **10%** of partner's mage purchases · **12%** of partner's Magic purchases · **25 gems** per invited partner. Footnote: "* Multi-accounts are not paid."
- Stats: Partners (count), Total income (gems).
- Table: Date · User · Deposit · Income (user shown as masked @username).
- All percentages/bonuses are admin settings and calculated **on the server**. Referral rewards are credited only after the partner passes the anti-abuse checks (section 9).
### 3.6 Profile
- User ID card, **Payments — History of replenishments [Open]**, **Withdrawal of funds — Withdrawal history [Open]**.
- Language selector (EN/RU/ZH/AR).

## 4. Settings (table `app_settings`, key → jsonb, cached 45 s per worker, `invalidateSettingsCache()` on save)

Economy: `deposit_rate_gems_per_usd (5000)`, `withdraw_rate_gems_per_usd (10000)`, `min_deposit_usd (1)`, `min_withdraw_gems (10000)`, `min_collect_gems`, `welcome_bonus_gems`, `ref_bonus_gems (25)`, `ref_mage_pct (10)`, `ref_magic_pct (12)`, `magic_burn_per_gem_earned`, mage table, magic packs table.
Withdrawals: `withdrawals_open`, `withdraw_bep20_open`, `withdraw_gram_open` (all "on"/"off"), `withdrawal_fee_type` ("flat"|"percent"), `withdrawal_fee_value`, `free_withdrawal_cap_usd`, `min_account_age_hours (12)`.
Deposits: `deposits_open`, `auto_deposit` ("on" = cron scans), `dep_coin_<GRAM|USDT|BNB|ETH|USDC>` and `dep_chain_<eth|bsc|ton>` toggles, `ton_address`, `memo_prefix ("MAG-")`.
Autopay: `autopay_enabled`, `autopay_bep20`, `autopay_gram`, `autopay_max_usd`, `autopay_max_times`, `autopay_min_deposit`.
Security: `max_new_accounts_per_ip (5)`, `ip_retention_days (30)`.
Join gate: `join_channel`, `join_payment_channel`, `join_channels_extra`.
Other: `cron_key` (random secret for the cron endpoint), `promo_popup_text`, `promo_popup_enabled`.

## 5. Admin panel — EVERYTHING that OminiAi's admin has (+ Mages & Magic)

Route `/admin`, horizontal pill tabs, mobile first. Access = `ADMIN_TG_ID` env owner(s) + admins stored in table `admins` (60 s cache). Every endpoint calls `requireAdmin(initData)` server-side. All the functions below exist in OminiAi's `admin.functions.ts`; recreate each one with the same names and behaviour (skeletons in section 17).

Tabs: **Dashboard · Users · Withdrawals · Frozen · Deposits · Check Deposit · Broadcast · Autopay · Settings · Mages & Magic**

1. **Dashboard** (`adminDashboard`): total users, banned, new in 24 h, pending withdrawals, gems in circulation, deposits (all / today), withdrawals paid (all / today), profit (all / today) = deposits − withdrawals. Sums come from SQL `admin_totals` (never from row reads, they are capped at 1000 rows).
2. **Users** (`adminSearchUsers`, `adminGetUser`, `adminUpdateUser`, `adminManualDeposit`): search by Telegram ID or username/name (30 results). User detail card: name, ID, username, wallet index, joined, last seen, gems, pending withdrawals, frozen, total deposit/withdrawal, mages owned, referrals count, referred by, ban status/reason, the user's EVM deposit address and GRAM memo. Actions: add/subtract gems with reason, ban / unban with reason (ban auto-rejects + refunds pending withdrawals), freeze amount with reason, **manual deposit** (chain, coin, tx hash, amount → credited with `force`), view withdrawals. Plus the **Suspicious** screen (`adminSuspicious`, last 7 days: no username + no activity, burst of 3+ signups under one referrer within 2 min, hit the free cap within 24 h of joining, flagged IP) with multi-select **Bulk ban** (`adminBulkBan`, up to 500, skips admins).
3. **Withdrawals** (`adminWithdrawals`, `adminReviewWithdrawal`, `adminFreezeWithdrawal`, `adminDeleteWithdrawals`): big switches **Withdrawals OPEN/CLOSED**, **BSC-USDT (BEP20) OPEN/CLOSED**, **GRAM-USDT OPEN/CLOSED**; status tabs pending / paid / rejected; per request: amount, fee, chain, address, user, date, "View account", total withdrawn, times paid, frozen amount, tx link; buttons **⚡ Auto pay**, **✅ Paid** (manual tx hash), **❌ Reject** (reason, refund yes/no), **🧊 Freeze**, **Unfreeze**; delete one finished record or **Delete all paid/rejected** (pending are never deleted).
4. **Frozen** (`adminFrozenUsers`, `adminUnfreeze`): list of users with admin freeze, total frozen, unfreeze partly or fully (user gets a bot DM).
5. **Deposits** (`adminDeposits`): last 200, optional filter by user ID; shows user, wallet index, chain, coin, amount, USD value, gems, status (`confirmed`, `below_minimum`, `fake`), tx hash with explorer link.
6. **Check Deposit** (`adminInspectAddress`): paste a `0x…` deposit address → finds the owner via wallet index, re-scans and credits missing deposits, then lists every incoming/outgoing transfer on BNB Chain + Ethereum with badges (Official / Unofficial, Credited / Not credited / Below min) and explorer links.
7. **Broadcast** (`adminBroadcast`): target `all` or one Telegram ID, HTML text, optional image URL, up to 10 URL buttons; sends in batches of 50 (25 parallel, 1 s pause, 429 retry), returns total/sent/failed/blocked/batches/errors and stores a row in `broadcasts`.
8. **Autopay** (`adminSaveSettings`): toggles Auto payment, Auto pay USDT BEP20, Auto pay USDT GRAM; numbers Max autopay amount (USD, 0 = never auto), Max paid withdrawals per user (0 = no limit), Min total deposit (0 = none).
9. **Settings** (`adminGetSettings`, `adminSaveSettings`, `adminAddAdmin`, `adminRemoveAdmin`, `adminSetupWebhook`): every numeric setting from section 4, fee type flat/percent, **GRAM deposit address + memo prefix**, **deposit switches** (`deposits_open`, `auto_deposit`, per coin, per chain), join gate (channel, payment channel, extra channels one per line, warning that the bot must be channel admin), admins list (owner cannot be removed, cannot remove yourself), **Connect bot** button (sets the webhook with secret token).
10. **Mages & Magic (new)**: edit mage price / % / gems-per-day / enabled / image, edit magic packs, preview.

All admin actions write an `admin_actions` row (who, what, target, reason, time).

## 6. Data model (Supabase; RLS on; `GRANT ... TO service_role` only; no client access)

Same core as OminiAi, adapted to gems (full SQL in section 16):

`users` (tg_user_id PK, wallet_index unique from a sequence, name, username, gems_balance, gems_frozen (pending withdrawals), admin_frozen, magic_balance, total_deposit_usd, total_withdrawal_usd, referral_earnings, referral_unclaimed, referred_by, joined_at, last_seen_at, is_banned, ban_reason) · `user_mages` · `deposits` (unique `(tx_hash, asset)`) · `withdrawals` (pending → processing → paid/rejected) · `referrals` · `ledger` (append-only, replaces OminiAi `transactions`) · `app_settings` · `admins` · `broadcasts` · `device_ban` · `ip_ban` · `rate_limits` · `admin_actions`.
Do **not** recreate OminiAi's retired `wallets` and `device_fingerprints` tables. Boot = one call (`getMe` → `boot_user` RPC).

## 7. Payments

Implemented exactly as OminiAi: see sections 12 (coin/chain catalogue), 13 (deposit engine), 14 (withdraw + payout + autopay), 15 (bot webhook), 16 (SQL), 18 (env + cron).

## 8. Referral rules

- Server-side only. No self-referral, no duplicate claim, race-safe.
- Reward only if the invited account is not banned/flagged and passes the account-age gate.
- Multi-accounts are never paid (and get banned, section 9).

## 9. Security (implement ALL of this + follow security.md)

**Auth & access**
- Validate Telegram `initData` on the server (HMAC with bot token), reject expired/replayed `auth_date`. Never trust client `user_id`. Short-lived sessions.
- Deny by default; owner/admin checked on every admin endpoint server-side; no IDOR; admin endpoints separate and rate-limited; re-confirm destructive/financial admin actions.
- Secrets only in server env/Cloudflare secrets (bot token, service-role key, mnemonic/keys, cron secret). Nothing privileged in the frontend bundle.

**Multiple-account ban**
- **One account per device**: a device fingerprint is required at app open; the first account that uses a device owns it; any other account on that device is auto-banned (`device_ban`, `check_device_ip` RPC). Admins exempt.
- Max new accounts per IP per hour (setting) → extra accounts auto-flagged/banned; flagged IPs go to `ip_ban`.
- Banned account: pending withdrawals auto-rejected with refund, referral rewards stopped, session revoked, ban reason stored.
- Admin can ban/unban manually and in bulk, and can review the Suspicious list.

**Bot / fake account ban**
- Reject requests without valid `initData`; ignore Telegram users flagged `is_bot`.
- Heuristics for fake accounts: no username + no activity, burst of 3+ signups under one referrer within 2 minutes, hitting the free withdrawal cap within 24h of joining, flagged IP. These feed the Suspicious view and can auto-hold rewards/withdrawals.
- Account age gate before first withdrawal (`min_account_age_hours`).
- Rate limits per account and IP using `rate_hit` (collect, buy, deposit check, withdraw, referral claim, admin login/actions).
- Honest anti-automation: request signing by `initData`, idempotency keys on every state-changing call, cooldowns on collect/buy.

**Money integrity**
- Backend + ledger are the source of truth; atomic and idempotent balance changes; integer/decimal money (no floats); unique external tx ids; negative balance alerts; withdrawal hold uses `FOR UPDATE` so parallel requests cannot double-debit; emergency switch to pause withdrawals.

**Privacy / data minimisation (security.md section 1)**
- Fingerprint and IP are needed only for anti-abuse: store them **hashed (salted SHA-256)**, never raw; keep no history lists; delete IP rows after a documented retention period (default 30 days) except active bans.
- Do not store name/phone/email/photos/contacts. Store Telegram ID + username only if needed. Do not log request bodies, initData, tokens.
- Generic error messages to client; no stack traces; strict CORS; HTTPS only; CSP; escape all output.
- Add `/legal` page with terms, risk notice, privacy notice describing exactly what is stored.

**Release gate**: before publishing, walk the checklist in security.md section 15 and report which items are done in `roadmap.md`.

## 10. Honesty requirements (apply to all UI copy)

- Show "estimated" next to daily income and never promise or guarantee returns.
- Include a visible risk notice on Deposit and in `/legal`: earnings depend on in-game rules, can change, and withdrawals are subject to review and limits.
- No fake testimonials, no "trusted by", "safe", "guaranteed" claims.

---

## 11. Code reference (sections 12–18)

Sections 12–18 are the reference implementation, taken from the working OminiAi project and adapted to MagiqAi (gems instead of coins/USDT balances, coin → chain deposit flow, extra on/off switches, env-based wallet addresses, hashed fingerprint/IP). Follow the structure and function names; change only what MagiqAi needs.

## 12. Coin → chain catalogue and deposit routing (client-safe `src/lib/assets.ts`)

Same idea as OminiAi's `CHAINS`, but indexed by coin first. A coin with one chain is "native/direct".

```ts
export type ChainId = "eth" | "bsc" | "ton";
export const LOGO = {
  USDT: "https://assets.coingecko.com/coins/images/325/large/Tether.png",
  USDC: "https://assets.coingecko.com/coins/images/6319/large/usdc.png",
  ETH:  "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
  BNB:  "https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png",
  GRAM: "https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png",
} as const;

export interface ChainDef { id: ChainId; name: string; network: string; logo: string; wallet: "evm" | "ton"; explorerTx: string; }
export const CHAINS: Record<ChainId, ChainDef> = {
  eth: { id: "eth", name: "Ethereum",  network: "ERC20", logo: LOGO.ETH,  wallet: "evm", explorerTx: "https://etherscan.io/tx/" },
  bsc: { id: "bsc", name: "BNB Chain", network: "BEP20", logo: LOGO.BNB,  wallet: "evm", explorerTx: "https://bscscan.com/tx/" },
  ton: { id: "ton", name: "GRAM",      network: "GRAM",  logo: LOGO.GRAM, wallet: "ton", explorerTx: "https://tonviewer.com/transaction/" },
};

export interface CoinDef { symbol: string; label: string; logo: string; stable: boolean; chains: ChainId[]; }
export const COINS: CoinDef[] = [
  { symbol: "GRAM", label: "GRAM", logo: LOGO.GRAM, stable: false, chains: ["ton"] },               // native → direct
  { symbol: "USDT", label: "Tether USD", logo: LOGO.USDT, stable: true,  chains: ["bsc", "ton", "eth"] },
  { symbol: "BNB",  label: "BNB",  logo: LOGO.BNB,  stable: false, chains: ["bsc"] },               // native → direct
  { symbol: "ETH",  label: "ETH",  logo: LOGO.ETH,  stable: false, chains: ["eth"] },               // native → direct
  { symbol: "USDC", label: "USDC", logo: LOGO.USDC, stable: true,  chains: ["bsc", "eth"] },
];
export const coinBySymbol = (s: string) => COINS.find((c) => c.symbol === s);

/** Withdrawals are always USDT, only BEP20 or GRAM. */
export const WITHDRAW_OPTIONS = [
  { chain: "bsc", asset: "USDT", label: "USDT BEP20", network: "BNB Chain", logo: LOGO.USDT, chainLogo: LOGO.BNB },
  { chain: "ton", asset: "USDT", label: "USDT GRAM",  network: "GRAM",      logo: LOGO.USDT, chainLogo: LOGO.GRAM },
] as const;

const TRUST_COIN: Record<ChainId, number> = { eth: 60, bsc: 20000714, ton: 607 };
export function walletLink(chain: ChainDef, address: string, memo?: string | null) {
  if (chain.wallet === "ton") return `https://app.tonkeeper.com/transfer/${address}${memo ? `?text=${encodeURIComponent(memo)}` : ""}`;
  return `https://link.trustwallet.com/send?coin=${TRUST_COIN[chain.id]}&address=${address}`;
}
```

Route logic (`src/routes/deposit.tsx`): this is the "select coin > chain > deposit page, native goes direct" rule.

```tsx
export const Route = createFileRoute("/deposit")({
  validateSearch: (s: Record<string, unknown>): { coin?: string; chain?: string } => ({
    ...(typeof s.coin === "string" ? { coin: s.coin } : {}),
    ...(typeof s.chain === "string" ? { chain: s.chain } : {}),
  }),
  component: () => <Shell><Deposit /></Shell>,
});

function Deposit() {
  const { coin, chain } = Route.useSearch();
  const { data } = useMe();                         // contains admin switches (see getMe)
  if (data && !data.settings.depositsOpen) return <ClosedPopup />;
  const c = coin ? coinBySymbol(coin) : undefined;
  if (!c) return <PickCoin />;                      // step 1
  const enabledChains = c.chains.filter((id) => data?.settings.depChains[id] !== false);
  if (enabledChains.length === 0) return <ClosedPopup />;
  // Native coin (single chain) → go straight to the deposit page.
  const ch = chain && enabledChains.includes(chain as ChainId) ? (chain as ChainId)
           : enabledChains.length === 1 ? enabledChains[0]! : undefined;
  if (!ch) return <PickChain coin={c} chains={enabledChains} />;   // step 2
  return <Address coin={c} chain={CHAINS[ch]} />;                  // step 3
}

function PickCoin() {
  const { data } = useMe();
  const px = useQuery({ queryKey: ["prices"], queryFn: livePrices, refetchInterval: 60000 });
  return COINS.filter((c) => data?.settings.depCoins[c.symbol] !== false).map((c) => (
    <Link key={c.symbol} to="/deposit" search={{ coin: c.symbol }} className={card}>
      <CoinImg src={c.logo} size={36} /> <b>{c.label}</b>
      <span>${(c.stable ? 1 : px.data?.values[c.symbol] ?? 0).toFixed(2)}</span>
    </Link>
  ));
}
// PickChain: list `chains` as cards (name + network) → <Link to="/deposit" search={{ coin: coin.symbol, chain: id }}>
// Address (step 3): copy OminiAi's Address component (QR, address, GRAM memo box, live rate, Check button, wallet deep link).
```

`getMe` must return these switches: `depositsOpen`, `depCoins: {GRAM:true,…}`, `depChains: {eth:true,bsc:true,ton:true}` (from `deposits_open`, `dep_coin_*`, `dep_chain_*`). The server also re-checks them in `getDepositAddress` and `checkDeposit` — never trust the UI.

## 13. Deposit engine (server) — same method as OminiAi

### 13.1 Deposit address (`getDepositAddress`)

```ts
export const getDepositAddress = createServerFn({ method: "POST" })
  .inputValidator((d) => auth.extend({ chain: z.enum(["eth", "bsc", "ton"]) }).parse(d))
  .handler(async ({ data }) => {
    const { verifyInitData } = await import("./telegram.server");
    const { getSettings } = await import("./core.server");
    const { user } = verifyInitData(data.initData);
    const s = await getSettings();
    if (String(s.deposits_open ?? "on") === "off" || String(s[`dep_chain_${data.chain}`] ?? "on") === "off")
      throw new Error("Deposits are temporarily closed for this network.");
    if (data.chain === "ton") return { address: String(s.ton_address), memoPrefix: String(s.memo_prefix ?? "") };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { evmAddressFor } = await import("./wallet.server");
    const { data: u } = await supabaseAdmin.from("users").select("wallet_index").eq("tg_user_id", user.id).single();
    if (!u) throw new Error("Account not found");
    return { address: evmAddressFor(u.wallet_index), memoPrefix: "" };   // generated, never stored
  });
```

### 13.2 EVM address from the secret words (`wallet.server.ts`)

```ts
import { HDNodeWallet } from "ethers";
function getMnemonic() { const m = process.env["MNEMONIC"]; if (!m) throw new Error("MNEMONIC is not configured"); return m.trim(); }
// The slow part (seed from words) runs once per worker; each address is then instant.
let evmBase: HDNodeWallet | null = null;
export function evmAddressFor(index: number): string {
  if (!evmBase) evmBase = HDNodeWallet.fromPhrase(getMnemonic(), undefined, "m/44'/60'/0'/0");
  return evmBase.deriveChild(index).address;
}
/** Which wallet number owns this EVM address (0..max), or null — used by admin "Check Deposit". */
export function findWalletIndex(address: string, max: number): number | null {
  const a = address.toLowerCase();
  for (let i = 0; i <= max; i++) if (evmAddressFor(i).toLowerCase() === a) return i;
  return null;
}
```

### 13.3 Scanner (`deposits.server.ts`)

Key rules (all copied from OminiAi): incoming transfers only; official token contracts only (a "USDT" that is not the official contract is recorded as `fake`, not credited, and the user is told); GRAM native needs a memo = `MAG-<tg id>`; every credited tx is deduped by `(tx_hash, asset)`; amounts use BigInt `formatUnits`; always `withRetry` network calls.

```ts
type Found = { chain: string; asset: string; tx: string; amount: number; fake?: boolean };
const looksStable = (sym: unknown) => /^(USDT|USDC|USD₮|USD₮0|TETHER)/i.test(String(sym ?? "").trim());

const EVM = {
  eth: { native: "ETH", tokens: { USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7", USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" } },
  bsc: { native: "BNB", tokens: { USDT: "0x55d398326f99059ff775485246999027b3197955", USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" } },
} as const;
const NODEREAL = { eth: { secret: "ETH_API", host: "eth-mainnet", dec: 6 }, bsc: { secret: "BSC_API", host: "bsc-mainnet", dec: 18 } } as const;
const TON_USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

async function getJson(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url.split("?")[0]} [${r.status}]`);
  return r.json() as Promise<any>;
}
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); } }
  throw last;
}
/** BigInt-safe hex → decimal amount. */
function formatUnits(hex: string, decimals: number): number {
  let v: bigint; try { v = BigInt(hex || "0x0"); } catch { return 0; }
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(frac ? `${v / base}.${frac}` : (v / base).toString());
}

/** ETH & BSC via NodeReal nr_getTransactionByAddress — incoming only. */
async function scanEvm(address: string): Promise<Found[]> {
  const out: Found[] = []; const me = address.toLowerCase();
  for (const chain of ["eth", "bsc"] as const) {
    const key = process.env[NODEREAL[chain].secret]; if (!key) continue;
    const cfg = EVM[chain];
    try {
      const j = await getJson(`https://${NODEREAL[chain].host}.nodereal.io/v1/${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nr_getTransactionByAddress",
          params: [{ category: ["external", "20"], address, order: "desc", maxCount: "0x64" }] }),
      });
      if (j.error) throw new Error(j.error.message);
      for (const t of (j.result?.transfers ?? []) as any[]) {
        const from = String(t.from ?? "").toLowerCase(), to = String(t.to ?? "").toLowerCase();
        if (from === me || to !== me) continue;                       // deposits only
        const tx = String(t.hash);
        if (t.category === "external") { const a = formatUnits(t.value, 18); if (a > 0) out.push({ chain, asset: cfg.native, tx, amount: a }); continue; }
        const contract = String(t.contractAddress ?? "").toLowerCase();
        const sym = Object.entries(cfg.tokens).find(([, c]) => c === contract)?.[0];
        if (sym) out.push({ chain, asset: sym, tx, amount: formatUnits(t.value, NODEREAL[chain].dec) });
        else if (looksStable(t.asset)) out.push({ chain, asset: String(t.asset).slice(0, 10), tx, amount: formatUnits(t.value, Number(t.decimal ?? 18)), fake: true });
      }
    } catch (e) { console.error("evm scan", chain, e); }
  }
  return out;
}

/** Any GRAM address form (UQ…/EQ…/0:hex) → canonical "wc:hex" so bounceable & non-bounceable forms match. */
export function tonRaw(addr: string): string {
  const a = String(addr ?? "").trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) { const [wc, h] = a.split(":"); return `${Number(wc)}:${h!.toLowerCase()}`; }
  try {
    const buf = Buffer.from(a.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length !== 36) return a.toLowerCase();
    return `${buf.readInt8(1)}:${buf.subarray(2, 34).toString("hex")}`;
  } catch { return a.toLowerCase(); }
}

/** Plain-text comment of a TonCenter v2 message (TonCenter decodes text comments into msg.dataText; dataRaw = binary → null). */
function tonMemo(m: any): string | null {
  const d = m?.msg_data;
  if (d?.["@type"] === "msg.dataText") {
    try { const t = Buffer.from(String(d.text ?? ""), "base64").toString("utf8").replace(/[^\x20-\x7E]/g, "").trim(); if (t) return t; } catch { /* fall through */ }
    return typeof m.message === "string" && m.message.trim() ? m.message.trim() : null;
  }
  if (d?.["@type"] === "msg.dataRaw") return null;
  return typeof m?.message === "string" && m.message.trim() ? m.message.trim() : null;
}

/** GRAM: one shared address. Native GRAM via TonCenter v2 (memo mandatory), USDT via TonCenter v3 jetton transfers (fallback TonAPI). */
export async function scanTon(tonAddress: string): Promise<(Found & { memo: string })[]> {
  const out: (Found & { memo: string })[] = []; const me = tonRaw(tonAddress); const key = process.env["TON_API_KEY"];
  try {
    const j = await withRetry(() => getJson(`https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(tonAddress)}&limit=50&archival=true`, key ? { headers: { "X-API-Key": key } } : undefined));
    for (const t of (j.result ?? []) as any[]) {
      const m = t.in_msg;
      if (!m?.source || tonRaw(m.destination) !== me || m.bounced) continue;
      const amount = formatUnits("0x" + BigInt(m.value || "0").toString(16), 9);
      const memo = tonMemo(m);                      // decoded text comment of the message
      if (amount > 0 && memo) out.push({ chain: "ton", asset: "GRAM", tx: String(t.transaction_id?.hash ?? ""), amount, memo });
    }
  } catch (e) { console.error("gram scan", e); }
  try {
    const j = await withRetry(() => getJson(`https://toncenter.com/api/v3/jetton/transfers?owner_address=${encodeURIComponent(tonAddress)}&direction=in&limit=50&sort=desc`, key ? { headers: { "X-API-Key": key } } : undefined));
    for (const t of (j.jetton_transfers ?? []) as any[]) {
      if (t.transaction_aborted || tonRaw(t.destination) !== me) continue;
      const memo = String(t.decoded_forward_payload?.comment ?? t.comment ?? "").trim(); if (!memo) continue;
      const tx = t.trace_id ? Buffer.from(t.trace_id, "base64").toString("hex") : String(t.transaction_hash);
      if (tonRaw(t.jetton_master) === TON_USDT_MASTER) out.push({ chain: "ton", asset: "USDT", tx, amount: Number(t.amount) / 1e6, memo });
      // other stable-looking jettons → push with fake: true (recorded as "fake", never credited)
    }
  } catch (e) { console.error("gram usdt scan (toncenter) – fall back to tonapi.io /accounts/{addr}/jettons/{USDT}/history", e); }
  return out;
}
```

### 13.4 Live prices (server fallback chain)

```ts
// Browser calls Binance first (livePrices() in src/lib/prices.ts). Server fallback = getPrices():
// Binance → data-api.binance.vision → Coinbase /v2/prices/{SYM}-USD/spot → OKX /api/v5/market/ticker → CoinGecko; cached 60 s,
// concurrent callers share one request (inflight promise); returns { values, updatedAt, stale }.
// Add GET /api/public/prices-check that reports each source's status (admin debugging).
```

### 13.5 Credit (stable = $1, others = amount × live price) → gems

```ts
export async function credit(userId: number, f: Found, s: Settings, opts: { force?: boolean } = {}) {
  if (f.fake) return rejectFake(userId, f);                         // status "fake", DM the user, never credited
  const stable = f.asset === "USDT" || f.asset === "USDC";
  const p = stable ? {} : (await prices()).values;
  const usd = Math.round(f.amount * (stable ? 1 : p[f.asset] ?? 0) * 1e4) / 1e4;
  if (!opts.force && usd < Number(s.min_deposit_usd)) {              // store as below_minimum, no credit
    const { data } = await supabaseAdmin.from("deposits").upsert({ user_id: userId, chain: f.chain, asset: f.asset, tx_hash: f.tx, amount: f.amount, usd_value: usd, gems_credited: 0, status: "below_minimum" },
      { onConflict: "tx_hash,asset", ignoreDuplicates: true }).select("id");
    return data?.length ? { ...f, usd, gems: 0, below: true } : null;
  }
  if (usd <= 0) return null;
  const { data, error } = await supabaseAdmin.rpc("credit_deposit", {      // atomic, idempotent (see section 16)
    p_user: userId, p_chain: f.chain, p_asset: f.asset, p_tx: f.tx, p_amount: f.amount, p_usd: usd, p_rate: Number(s.deposit_rate_gems_per_usd),
  });
  if (error) throw new Error(error.message);
  if (data == null) return null;                                     // duplicate tx
  await notify(userId, `✅ <b>Deposit confirmed</b>\n${f.amount} ${f.asset} (${f.chain}) ≈ $${usd} → <b>+${data} gems</b>\nTx: <code>${f.tx}</code>`);
  return { ...f, usd, gems: Number(data) };
}
```

### 13.6 Scan one user / all active users + switches

```ts
export async function scanUser(u: { tg_user_id: number; wallet_index: number; is_banned: boolean }, tonCache?: (Found & { memo: string })[]) {
  if (u.is_banned) return [];
  const s = await getSettings();
  if (String(s.deposits_open ?? "on") === "off") return [];
  const found: Found[] = [];
  const { evmAddressFor } = await import("./wallet.server");
  found.push(...(await scanEvm(evmAddressFor(u.wallet_index))));
  const ton = tonCache ?? (await scanTon(s.ton_address));
  const myMemo = `${s.memo_prefix}${u.tg_user_id}`.trim().toUpperCase();
  found.push(...ton.filter((t) => t.memo.trim().toUpperCase() === myMemo));
  // skip coins/chains the admin switched off
  const allowed = found.filter((f) => String(s[`dep_chain_${f.chain}`] ?? "on") !== "off" && String(s[`dep_coin_${f.asset}`] ?? "on") !== "off");
  const known = await knownTx(allowed.map((f) => f.tx));
  const credited = [];
  for (const f of allowed) { if (known.has(f.tx)) continue; try { const c = await credit(u.tg_user_id, f, s); if (c) credited.push(c); } catch (e) { console.error("credit failed", e); } }
  return credited;
}

/** Cron: only users seen in the last 48 h; one shared GRAM scan for everybody. */
export async function scanActiveUsers() {
  const s = await getSettings();
  if (String(s.auto_deposit ?? "on") === "off") return { skipped: "auto_deposit is off" };
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data: users } = await supabaseAdmin.from("users").select("tg_user_id,wallet_index,is_banned").eq("is_banned", false).gte("last_seen_at", since).limit(200);
  const ton = await scanTon(s.ton_address);
  let total = 0;
  for (const u of users ?? []) total += (await scanUser(u, ton)).length;
  return { users: users?.length ?? 0, credited: total };
}
```

### 13.7 Manual "Check deposit" button (works even if `auto_deposit = off`) and cron route

```ts
export const checkDeposit = createServerFn({ method: "POST" }).inputValidator((d) => auth.parse(d)).handler(async ({ data }) => {
  const { user } = verifyInitData(data.initData, 3600);
  await rateLimit(`dep:${user.id}`, 1, 10);                          // 1 call / 10 s
  const { data: u } = await supabaseAdmin.from("users").select("tg_user_id,wallet_index,is_banned").eq("tg_user_id", user.id).single();
  if (!u || u.is_banned) throw new Error("Account restricted");
  const all = await scanUser(u);
  const s = await getSettings();
  return {
    credited: all.filter((c) => !("below" in c && c.below) && c.gems > 0).map((c) => ({ chain: c.chain, asset: c.asset, amount: c.amount, usd: c.usd, gems: c.gems })),
    belowMinimum: all.filter((c) => "below" in c && c.below).map((c) => ({ asset: c.asset, amount: c.amount, usd: c.usd })),
    minDeposit: Number(s.min_deposit_usd),
  };
});
```

```ts
// src/routes/api/public/cron/scan-deposits.ts — called every minute by Cloudflare Cron Trigger / cron-job.org
export const Route = createFileRoute("/api/public/cron/scan-deposits")({
  server: { handlers: { POST: async ({ request }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "cron_key").maybeSingle();
    const key = request.headers.get("x-cron-key");
    if (!data || !key || JSON.stringify(key) !== JSON.stringify(data.value)) return new Response("Unauthorized", { status: 401 });
    const { scanActiveUsers } = await import("@/lib/deposits.server");
    return Response.json(await scanActiveUsers());
  } } },
});
```

---

## 14. Withdrawals: request → admin alert → (autopay | manual) → paid/rejected

### 14.1 `requestWithdrawal` (server function; amounts in gems, payout in USDT)

```ts
export const requestWithdrawal = createServerFn({ method: "POST" })
  .inputValidator((d) => auth.extend({
    chain: z.string().max(20), asset: z.string().max(10),
    address: z.string().trim().min(10).max(120), gems: z.number().positive().max(1e12),
  }).parse(d))
  .handler(async ({ data }) => {
    const { user } = verifyInitData(data.initData, 3600);
    await rateLimit(`wd:${user.id}`, 1, 3);
    if (!WITHDRAW_OPTIONS.some((o) => o.chain === data.chain && o.asset === data.asset)) throw new Error("Only USDT BEP20 or USDT GRAM withdrawals are supported");
    const s = await getSettings();
    const off = (k: string) => String(s[k] ?? "on") === "off";
    if (off("withdrawals_open")) throw new Error("Withdrawals are currently closed. Please try again later.");
    if (off(data.chain === "ton" ? "withdraw_gram_open" : "withdraw_bep20_open")) throw new Error("This withdrawal method is not available right now.");
    if (data.gems < Number(s.min_withdraw_gems)) throw new Error(`Minimum withdrawal is ${s.min_withdraw_gems} gems`);

    const { data: me } = await supabaseAdmin.from("users").select("is_banned,gems_balance,admin_frozen,total_deposit_usd,joined_at").eq("tg_user_id", user.id).single();
    if (!me || me.is_banned) throw new Error("Account restricted");

    // 1) account age gate (first withdrawal only)
    const minAgeH = Number(s.min_account_age_hours ?? 12);
    if (minAgeH > 0 && me.joined_at) {
      const ready = new Date(me.joined_at).getTime() + minAgeH * 3600000;
      if (ready > Date.now()) {
        const { count: prev } = await supabaseAdmin.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", user.id);
        if (!prev) throw new Error(`New accounts can make their first withdrawal after ${minAgeH} hours. Try again in about ${Math.ceil((ready - Date.now()) / 3600000)} hour(s).`);
      }
    }
    // 2) 24 h between withdrawals
    const { data: last } = await supabaseAdmin.from("withdrawals").select("created_at").eq("user_id", user.id).neq("status", "rejected").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last && new Date(last.created_at).getTime() + 86400000 > Date.now()) throw new Error("You can withdraw once every 24 hours.");
    // 3) balance
    const available = Number(me.gems_balance) - Number(me.admin_frozen);
    if (data.gems > available + 1e-9) throw new Error(`Only ${Math.max(0, available).toFixed(0)} gems are available`);
    // 4) free cap for users who never deposited
    const usd = data.gems / Number(s.withdraw_rate_gems_per_usd);
    const needsCap = Number(me.total_deposit_usd) < Math.max(Number(s.min_deposit_usd) || 0, 1e-9);
    const cap = Number(s.free_withdrawal_cap_usd ?? 0.25);
    if (needsCap) {
      const { data: wds } = await supabaseAdmin.from("withdrawals").select("amount_usd").eq("user_id", user.id).neq("status", "rejected");
      const used = (wds ?? []).reduce((a, w) => a + Number(w.amount_usd), 0);
      if (used + usd > cap + 1e-9) throw new Error(used >= cap ? `You used your free withdrawal limit of $${cap}. Please make a deposit first.` : `Without a deposit you can withdraw up to $${cap} in total.`);
    }
    // 5) fee
    const fee = s.withdrawal_fee_type === "percent" ? (usd * Number(s.withdrawal_fee_value)) / 100 : Number(s.withdrawal_fee_value);
    if (fee >= usd) throw new Error("Amount is too small to cover the fee");

    // 6) atomic hold (locks the user row; re-checks ban/24h/balance/cap; inserts the request; moves gems balance → frozen)
    const { data: wid, error } = await supabaseAdmin.rpc("withdraw_hold", {
      p_user: user.id, p_chain: data.chain, p_asset: data.asset, p_address: data.address,
      p_gems: data.gems, p_usd: usd, p_fee_usd: fee, p_free_cap: cap, p_needs_cap: needsCap,
    });
    if (error || !wid) throw new Error(error?.message || "Please try again");

    // 7) bot messages (never block the request on Telegram errors)
    try {
      await notify(user.id, `🕒 <b>Withdrawal request submitted</b>\n💰 ${data.gems} gems ≈ <b>${usd.toFixed(4)} USDT</b>${fee ? ` (fee ${fee}, you receive ${(usd - fee).toFixed(4)})` : ""}\n🔗 Network: ${data.chain === "ton" ? "GRAM" : "BEP20 (BSC)"}\n📬 To: <code>${esc(data.address)}</code>`);
      await alertAdminsNewWithdrawal({ id: wid as string, user_id: user.id, chain: data.chain, gems: data.gems, usd, fee, address: data.address });
    } catch (e) { console.error("withdrawal notify", e); }

    // 8) AUTOPAY: only if admin enabled it AND every limit passes; otherwise it waits for an admin
    try {
      const on = (v: unknown, d = "on") => String(v ?? d) === "on";
      const methodOn = data.chain === "ton" ? on(s.autopay_gram) : on(s.autopay_bep20);
      const maxAmt = Number(s.autopay_max_usd ?? 0), maxTimes = Number(s.autopay_max_times ?? 0), minDep = Number(s.autopay_min_deposit ?? 0);
      if (on(s.autopay_enabled, "off") && methodOn && maxAmt > 0 && usd <= maxAmt + 1e-9 && Number(me.total_deposit_usd) >= minDep) {
        const { count: paidTimes } = await supabaseAdmin.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "paid");
        if (maxTimes <= 0 || (paidTimes ?? 0) < maxTimes) await reviewWithdrawal({ id: wid as string, action: "pay", adminId: 0, auto: true });
      }
    } catch (e) { console.error("autopay", wid, e); }
    return { id: wid as string };
  });
```

### 14.2 Payout wallets (`payout.server.ts`) — same method as OminiAi

BEP20 USDT: index-0 wallet of `PAY_WALLET_SECRET` (12+ words), legacy tx on BSC, several public RPCs with fallback, wait for the receipt.

```ts
import { HDNodeWallet, Interface, getAddress, isAddress, parseUnits, formatUnits } from "ethers";
const CHAIN_ID = 56;
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const RPCS = ["https://bsc-dataseed.binance.org/", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.binance.org/"];
const IFACE = new Interface(["function balanceOf(address owner) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (v: string) => v.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

async function rpc(method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error("BSC RPC failed");
}
function payWallet() {
  const phrase = (process.env["PAY_WALLET_SECRET"] || "").trim();
  if (phrase.split(/\s+/).length < 12) throw new Error("Payout wallet is not configured");
  return HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0/0");
}
/** Sends USDT (BEP20) and waits for the receipt. Returns the tx hash. */
export async function sendUsdtBep20(to: string, amount: number): Promise<string> {
  if (!isAddress(to)) throw new Error("Invalid BEP20 address");
  const wallet = payWallet();
  const value = parseUnits(amount.toFixed(6), 18);
  if (value <= 0n) throw new Error("Amount is zero");
  const bal = BigInt(await rpc("eth_call", [{ to: USDT, data: IFACE.encodeFunctionData("balanceOf", [wallet.address]) }, "latest"]));
  if (bal < value) throw new Error(`Payout wallet low: ${formatUnits(bal, 18)} USDT, need ${amount}`);
  if (BigInt(await rpc("eth_getBalance", [wallet.address, "latest"])) === 0n) throw new Error("Payout wallet has no BNB for gas");
  const data = IFACE.encodeFunctionData("transfer", [getAddress(to), value]);
  const [nonceHex, gasPriceHex] = await Promise.all([rpc("eth_getTransactionCount", [wallet.address, "pending"]), rpc("eth_gasPrice", [])]);
  let gasLimit = 100000n;
  try { gasLimit = (BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to: USDT, data }])) * 12n) / 10n; } catch { /* default */ }
  const raw = await wallet.signTransaction({ type: 0, chainId: CHAIN_ID, to: USDT, nonce: Number(BigInt(nonceHex)), gasPrice: BigInt(gasPriceHex), gasLimit, data });
  const hash: string = await rpc("eth_sendRawTransaction", [raw]);
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) { if (r.status !== "0x1") throw new Error(`Transaction reverted: ${hash}`); return hash; }
  }
  return hash; // broadcast, confirmation pending — hash is on BscScan
}
```

GRAM USDT (TEP-74 jetton transfer): BIP39 seed → SLIP-10 `m/44'/607'/0'` → WalletV5R1, via TonCenter `sendBoc`. **Do not hardcode wallet addresses** (OminiAi did): read `PAY_TON_ADDRESS` from env and refuse to send if the derived wallet differs.

```ts
import { pbkdf2Sync } from "crypto";
import { getED25519MasterKeyFromSeed, deriveED25519HardenedKey, keyPairFromSeed } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";
import { Address, Cell, beginCell, internal, external, storeMessage, SendMode } from "@ton/core";

const RPC = "https://toncenter.com/api/v2/jsonRPC";
const USDT_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const MEMO = "MagiqAiBot";                                 // comment shown on the user's incoming transfer
const MSG_VALUE = 30000000n, FORWARD_TON = 2000000n, MIN_TON = 40000000n, DECIMALS = 6;

function apiKey() { const k = process.env["PAY_TONCENTER_API"] || process.env["TON_API_KEY"] || ""; if (!k) throw new Error("GRAM payout API key is not configured"); return k; }
async function tonRpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey() }, body: JSON.stringify({ id: "1", jsonrpc: "2.0", method, params }) });
  const j = (await r.json()) as { ok?: boolean; result?: any; error?: string };
  if (!j.ok) throw new Error(`TonCenter: ${j.error || "rpc fail"}`);
  return j.result;
}
const stackNum = (e: any) => { if (!e || e[0] !== "num") throw new Error("Bad TON stack"); return BigInt(e[1]); };
async function tonWallet() {
  const phrase = (process.env["TON_WALLET_SECRET"] || "").trim();
  if (phrase.split(/\s+/).length < 12) throw new Error("GRAM payout wallet is not configured");
  let st = await getED25519MasterKeyFromSeed(pbkdf2Sync(phrase, "mnemonic", 2048, 64, "sha512"));
  for (const i of [44, 607, 0]) st = await deriveED25519HardenedKey(st, i);
  const kp = keyPairFromSeed(st.key);
  const w = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey });
  if (!w.address.equals(Address.parse(process.env["PAY_TON_ADDRESS"]!))) throw new Error("GRAM payout wallet secret does not match PAY_TON_ADDRESS");
  return { w, secretKey: kp.secretKey };
}
const seqno = async (a: Address) => Number(stackNum((await tonRpc("runGetMethod", { address: a.toString(), method: "seqno", stack: [] })).stack[0]));

export async function sendUsdtTon(to: string, amount: number): Promise<string> {
  let dest: Address; try { dest = Address.parse(to.trim()); } catch { throw new Error("Invalid GRAM address"); }
  const value = BigInt(Math.floor(amount * 10 ** DECIMALS)); if (value <= 0n) throw new Error("Amount is zero");
  const { w, secretKey } = await tonWallet(); const owner = w.address;
  const res = await tonRpc("runGetMethod", { address: USDT_MASTER, method: "get_wallet_address", stack: [["tvm.Slice", beginCell().storeAddress(owner).endCell().toBoc().toString("base64")]] });
  const jw = Cell.fromBoc(Buffer.from(res.stack[0][1].bytes, "base64"))[0]!.beginParse().loadAddress();   // our USDT jetton wallet
  const ton = BigInt((await tonRpc("getAddressInformation", { address: owner.toString() })).balance);
  if (ton < MIN_TON) throw new Error(`Payout wallet needs at least 0.04 TON for fees (has ${Number(ton) / 1e9})`);
  let usdt = 0n; try { usdt = stackNum((await tonRpc("runGetMethod", { address: jw.toString(), method: "get_wallet_data", stack: [] })).stack[0]); } catch { usdt = 0n; }
  if (usdt < value) throw new Error(`Payout wallet low: ${Number(usdt) / 1e6} USDT, need ${amount}`);
  const comment = beginCell().storeUint(0, 32).storeStringTail(MEMO).endCell();
  const body = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(value).storeAddress(dest).storeAddress(owner)
    .storeBit(0).storeCoins(FORWARD_TON).storeBit(1).storeRef(comment).endCell();
  const sq = await seqno(owner);
  const signed = w.createTransfer({ seqno: sq, secretKey, messages: [internal({ to: jw, value: MSG_VALUE, body })], sendMode: SendMode.PAY_GAS_SEPARATELY });
  const extCell = beginCell().store(storeMessage(external({ to: owner, body: signed }))).endCell();
  const msgHash = extCell.hash().toString("hex");                 // normalized message hash
  await tonRpc("sendBoc", { boc: extCell.toBoc().toString("base64") });
  for (let i = 0; i < 5; i++) { await sleep(3000); if ((await seqno(owner).catch(() => sq)) > sq) break; }
  return (await txHashByMessage(msgHash)) || "";                  // TonCenter v3 /transactionsByMessage, retried 6×
}
```

### 14.3 `reviewWithdrawal` — the ONE path for pay/reject (admin panel, bot buttons, autopay)

```ts
export async function reviewWithdrawal(opts: { id: string; action: "pay" | "reject"; adminId: number; txHash?: string; reason?: string; refund?: boolean; auto?: boolean }) {
  const db = supabaseAdmin;
  // Lock: pending → processing. A second click/parallel autopay finds no pending row and fails with "Already reviewed".
  const { data: w, error: lockErr } = await db.from("withdrawals").update({ status: "processing", reviewed_by: opts.adminId }).eq("id", opts.id).eq("status", "pending").select("*").maybeSingle();
  if (lockErr) throw new Error(`Lock failed: ${lockErr.message}`);
  if (!w) throw new Error("Already reviewed");

  if (opts.action === "pay") {                                    // banned accounts are never paid
    const { data: bu } = await db.from("users").select("is_banned").eq("tg_user_id", w.user_id).single();
    if (bu?.is_banned) { await db.from("withdrawals").update({ status: "pending" }).eq("id", w.id); await db.rpc("ban_user", { p_user: w.user_id, p_reason: "banned", p_ip: "" }); throw new Error("Account is banned — withdrawal auto-rejected and refunded"); }
  }
  let tx = opts.txHash?.trim() || "";
  if (opts.action === "pay" && !tx && opts.auto === true) {       // auto send ONLY when the Auto-pay button / autopay asked for it
    try {
      const net = Math.max(0, Number(w.amount_usd) - Number(w.fee_usd));
      tx = w.chain === "ton" ? await (await import("./tonpay.server")).sendUsdtTon(w.address, net) : await sendUsdtBep20(w.address, net);
    } catch (e) { await db.from("withdrawals").update({ status: "pending" }).eq("id", w.id); throw e; }   // unlock so it can be retried
  }
  await db.from("withdrawals").update({
    status: opts.action === "pay" ? "paid" : "rejected", tx_hash: tx || null, reject_reason: opts.reason || null,
    refunded: opts.action === "reject" && !!opts.refund, reviewed_at: new Date().toISOString(),
  }).eq("id", w.id);
  await db.rpc("withdraw_settle", { p_user: w.user_id, p_gems: w.amount_gems, p_usd: w.amount_usd, p_paid: opts.action === "pay", p_refund: opts.action === "reject" && !!opts.refund, p_ref: w.id });

  const ton = w.chain === "ton";
  const txLink = tx ? (ton ? `https://tonscan.org/tx/${encodeURIComponent(tx)}` : `https://bscscan.com/tx/${encodeURIComponent(tx)}`) : "";
  if (opts.action === "pay") {
    await notify(w.user_id, `✅ <b>Withdrawal paid</b>\n${w.amount_usd} USDT sent to your ${ton ? "GRAM" : "BEP20"} address.${tx ? `\n🧾 Tx: <a href="${txLink}"><code>${esc(tx)}</code></a>` : ""}`);
    await postToChannel((await getSettings()).join_payment_channel, `💸 <b>Withdrawal Paid</b>\n👤 ID ${maskId(w.user_id)}\n💰 <b>${w.amount_usd} USDT</b>\n🔗 ${ton ? "GRAM" : "BEP20 (BSC)"}\n🧾 ${esc(txLink)}`);   // proof post in the payments channel, masked user
  } else {
    await notify(w.user_id, `❌ <b>Withdrawal rejected</b>\n${w.amount_usd} USDT${opts.reason ? ` — ${esc(opts.reason)}` : ""}.${opts.refund ? " The gems were returned to your balance." : ""}`);
  }
  return { ok: true, txHash: tx || null, amountUsd: Number(w.amount_usd), chain: w.chain, userId: w.user_id };
}
```

### 14.4 Admin alert with inline buttons (every admin gets it)

```ts
export async function alertAdminsNewWithdrawal(w: { id: string; user_id: number; chain: string; gems: number; usd: number; fee: number; address: string }) {
  const [{ data: u }, { count: times }] = await Promise.all([
    supabaseAdmin.from("users").select("total_deposit_usd,total_withdrawal_usd").eq("tg_user_id", w.user_id).maybeSingle(),
    supabaseAdmin.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", w.user_id).eq("status", "paid"),
  ]);
  const text = `🔔 <b>New withdrawal request</b>\n🆔 User ID: <code>${w.user_id}</code>\n💰 <b>${w.usd.toFixed(4)} USDT</b> (${w.gems} gems)\n🔗 ${w.chain === "ton" ? "USDT GRAM" : "USDT BEP20 (BSC)"}\n📬 <code>${esc(w.address)}</code>\n\n🔁 Times withdrawn: ${times ?? 0}\n⬆️ Total withdrawn: ${Number(u?.total_withdrawal_usd ?? 0)} USDT\n⬇️ Total deposit: $${Number(u?.total_deposit_usd ?? 0)}`;
  const kb = { inline_keyboard: [[{ text: "⚡ Auto payment", callback_data: `wd:auto:${w.id}` }], [{ text: "✅ Paid", callback_data: `wd:pay:${w.id}` }], [{ text: "❌ Reject", callback_data: `wd:rej:${w.id}` }, { text: "↩️ Reject + refund", callback_data: `wd:rejr:${w.id}` }]] };
  for (const id of await adminIds()) { try { await tgApi("sendMessage", { chat_id: id, text, parse_mode: "HTML", reply_markup: kb }); } catch (e) { console.error("admin alert", id, e); } }
}
```

## 15. Telegram bot (`src/routes/api/public/telegram/webhook.ts`)

- Verify the header `X-Telegram-Bot-Api-Secret-Token` with `timingSafeEqual` against `webhookSecret()` = `sha256("tg-webhook:"+BOT_TOKEN)` base64url. The admin **Connect bot** button calls `setWebhook` with that secret and `allowed_updates: ["message","callback_query"]`.
- `/start [ref]`: send `welcome.jpg` + caption + inline button **🚀 Open App** with `https://t.me/MagiqAiBot/<MINIAPP_SHORT_NAME>?startapp=<ref>`. A missing/self ref falls back to the sender's own id. Nothing else is handled.
- `callback_query` `wd:(pay|auto|rej|rejr):<uuid>`: must be an admin (`isAdmin`); shows "⏳ Sending USDT…", calls `reviewWithdrawal`, then edits the message to "✅ PAID (auto) + tx link", "❌ REJECTED (refunded)", "ℹ️ Already reviewed" or "⚠️ Failed: … try again" (buttons kept on failure).

```ts
const m = /^wd:(pay|auto|rej|rejr):([0-9a-f-]{36})$/.exec(String(cb.data ?? ""));
if (!m) return ack("Unknown action");
if (!cb.from?.id || !(await isAdmin(Number(cb.from.id)))) return ack("Only admins can do this", true);
const [, act, id] = m; const paying = act === "pay" || act === "auto";
await reviewWithdrawal({ id: id!, action: paying ? "pay" : "reject", adminId: Number(cb.from.id), auto: act === "auto", refund: act === "rejr", reason: paying ? undefined : "Rejected by admin" });
```

Other bot helpers (`telegram.server.ts`): `verifyInitData` (HMAC `WebAppData`, `timingSafeEqual`, `auth_date` max age), `tgApi`, `notify(chatId, html)` (never throws, has an "Open MagiqAi" button), `postToChannel`, `channelChatId`, `BOT_USERNAME = "MagiqAiBot"`.

---

## 16. SQL (Supabase migration) — atomic, idempotent, service_role only

Every function: `SECURITY DEFINER`, `SET search_path = public`, `REVOKE ALL ... FROM public, anon, authenticated`, `GRANT EXECUTE ... TO service_role`.

```sql
-- balances + append-only ledger in ONE place
create or replace function public.apply_balance(p_user bigint, p_kind text, p_gems numeric, p_note text default null, p_ref text default null)
returns public.users language plpgsql security definer set search_path = public as $$
declare r public.users;
begin
  update users set gems_balance = gems_balance + p_gems where tg_user_id = p_user returning * into r;   -- CHECK (gems_balance >= 0) blocks overdraft
  if r is null then raise exception 'user not found'; end if;
  insert into ledger(user_id, kind, gems_delta, note, ref_id) values (p_user, p_kind, p_gems, p_note, p_ref);
  return r;
end $$;

-- deposit → gems, deduped by (tx_hash, asset); returns null when the tx was already credited
create or replace function public.credit_deposit(p_user bigint, p_chain text, p_asset text, p_tx text, p_amount numeric, p_usd numeric, p_rate numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_gems numeric := round(p_usd * p_rate, 4); v_id uuid;
begin
  insert into deposits(user_id, chain, asset, tx_hash, amount, usd_value, gems_credited)
  values (p_user, p_chain, p_asset, p_tx, p_amount, p_usd, v_gems)
  on conflict (tx_hash, asset) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  update users set total_deposit_usd = total_deposit_usd + p_usd where tg_user_id = p_user;
  perform apply_balance(p_user, 'deposit', v_gems, p_asset || ' on ' || p_chain, p_tx);
  return v_gems;
end $$;

-- withdrawal hold: locks the user row so parallel requests can never double-debit
create or replace function public.withdraw_hold(p_user bigint, p_chain text, p_asset text, p_address text, p_gems numeric, p_usd numeric, p_fee_usd numeric, p_free_cap numeric, p_needs_cap boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare u users; v_id uuid; used numeric;
begin
  select * into u from users where tg_user_id = p_user for update;
  if u is null or u.is_banned then raise exception 'Account restricted'; end if;
  if exists (select 1 from withdrawals where user_id = p_user and status <> 'rejected' and created_at > now() - interval '24 hours')
    then raise exception 'You can withdraw once every 24 hours.'; end if;
  if u.gems_balance - u.admin_frozen < p_gems - 1e-9 then raise exception 'Not enough balance'; end if;
  if p_needs_cap then
    select coalesce(sum(amount_usd), 0) into used from withdrawals where user_id = p_user and status <> 'rejected';
    if used + p_usd > p_free_cap + 1e-9 then raise exception 'Free withdrawal limit reached. Please make a deposit first.'; end if;
  end if;
  insert into withdrawals(user_id, chain, asset, address, amount_gems, amount_usd, fee_usd) values (p_user, p_chain, p_asset, p_address, p_gems, p_usd, p_fee_usd) returning id into v_id;
  update users set gems_balance = gems_balance - p_gems, gems_frozen = gems_frozen + p_gems where tg_user_id = p_user;
  return v_id;
end $$;

-- after review: release the hold; paid → totals, rejected+refund → give gems back
create or replace function public.withdraw_settle(p_user bigint, p_gems numeric, p_usd numeric, p_paid boolean, p_refund boolean, p_ref uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update users set gems_frozen = greatest(0, gems_frozen - p_gems),
                   total_withdrawal_usd = total_withdrawal_usd + case when p_paid then p_usd else 0 end
   where tg_user_id = p_user;
  if p_refund then perform apply_balance(p_user, 'withdrawal_refund', p_gems, 'Rejected', p_ref::text); end if;
end $$;

-- ban + auto-reject pending withdrawals with refund
create or replace function public.ban_user(p_user bigint, p_reason text, p_ip text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update users set is_banned = true, ban_reason = p_reason where tg_user_id = p_user and not is_banned;
  for r in update withdrawals set status = 'rejected', reject_reason = 'banned account', refunded = true, reviewed_at = now()
           where user_id = p_user and status = 'pending' returning amount_gems loop
    update users set gems_balance = gems_balance + r.amount_gems, gems_frozen = greatest(0, gems_frozen - r.amount_gems) where tg_user_id = p_user;
  end loop;
  if p_ip is not null and p_ip <> '' then insert into ip_ban(ip, banned, user_id, note) values (p_ip, false, p_user, p_reason) on conflict (ip) do nothing; end if;
end $$;

-- device + IP in one round trip (inputs are already SALTED HASHES, see section 9). Returns true when banned.
create or replace function public.check_device_ip(p_user bigint, p_fp text, p_ip text)
returns boolean language plpgsql security definer set search_path = public as $$
declare owner bigint;
begin
  if p_ip is not null and exists (select 1 from ip_ban where ip = p_ip and banned) then perform ban_user(p_user, 'banned ip', null); return true; end if;
  insert into device_ban(device_fingerprint, user_id) values (p_fp, p_user) on conflict (device_fingerprint) do nothing;
  select user_id into owner from device_ban where device_fingerprint = p_fp;
  if owner is distinct from p_user then perform ban_user(p_user, 'duplicate device', p_ip); return true; end if;
  return false;
end $$;

-- bounded rate-limit counters (one row per key)
create or replace function public.rate_hit(p_key text, p_max int, p_window_sec int)
returns boolean language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into rate_limits(key, count, window_start) values (p_key, 1, now())
  on conflict (key) do update set
    count = case when rate_limits.window_start < now() - make_interval(secs => p_window_sec) then 1 else rate_limits.count + 1 end,
    window_start = case when rate_limits.window_start < now() - make_interval(secs => p_window_sec) then now() else rate_limits.window_start end
  returning count into c;
  return c <= p_max;
end $$;

-- dashboard sums (never read rows: PostgREST caps at 1000)
create or replace function public.admin_totals(p_since timestamptz) returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'gems', (select coalesce(sum(gems_balance),0) from users),
    'dep_all', (select coalesce(sum(usd_value),0) from deposits),
    'dep_today', (select coalesce(sum(usd_value),0) from deposits where created_at >= p_since),
    'wd_all', (select coalesce(sum(amount_usd),0) from withdrawals where status = 'paid'),
    'wd_today', (select coalesce(sum(amount_usd),0) from withdrawals where status = 'paid' and coalesce(reviewed_at, created_at) >= p_since));
$$;
```

Also write (same style): `boot_user(p_user)` (user row + friends count + withdrawn/pending sum in one call), `buy_mage(p_user, p_mage, p_qty)` and `buy_magic(p_user, p_pack)` (lock user row, accrue earnings first, deduct gems, upsert `user_mages`, ledger row, pay the referrer 10% / 12% into `referral_unclaimed` only if both accounts are clean), `collect_gems(p_user)` (server-time accrual, respects Magic), `claim_referral(p_user)`, `rate_hit` cleanup job. Tables follow the column lists in section 6; `deposits.status in ('confirmed','below_minimum','fake')`; `withdrawals.status in ('pending','processing','paid','rejected')` with `amount_gems, amount_usd, fee_usd, tx_hash, reject_reason, refunded, reviewed_by, reviewed_at`.

## 17. Admin panel code pattern (copy OminiAi's `admin.functions.ts` structure)

```ts
const auth = z.object({ initData: z.string().min(1).max(8000) });
async function ctx(initData: string) {
  const { requireAdmin } = await import("./core.server");        // verifyInitData + isAdmin(env ADMIN_TG_ID ∪ table admins, 60 s cache)
  const admin = await requireAdmin(initData);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return { admin, db: supabaseAdmin };
}

export const adminDashboard = createServerFn({ method: "POST" }).inputValidator((d) => auth.parse(d)).handler(async ({ data }) => {
  const { db } = await ctx(data.initData);
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const cnt = (q: any) => q.then((r: any) => r.count ?? 0);
  const [users, banned, today, pending, sums] = await Promise.all([
    cnt(db.from("users").select("*", { count: "exact", head: true })),
    cnt(db.from("users").select("*", { count: "exact", head: true }).eq("is_banned", true)),
    cnt(db.from("users").select("*", { count: "exact", head: true }).gte("joined_at", new Date(Date.now() - 86400000).toISOString())),
    cnt(db.from("withdrawals").select("*", { count: "exact", head: true }).eq("status", "pending")),
    db.rpc("admin_totals", { p_since: midnight.toISOString() }),
  ]);
  const t = (sums.data ?? {}) as Record<string, number>; const n = (k: string) => Number(t[k] ?? 0);
  return { users, banned, today, pending, gems: n("gems"), deposits: n("dep_all"), withdrawals: n("wd_all"),
           depositsToday: n("dep_today"), withdrawalsToday: n("wd_today"), profitToday: n("dep_today") - n("wd_today"), profitAll: n("dep_all") - n("wd_all") };
});

export const adminReviewWithdrawal = createServerFn({ method: "POST" })
  .inputValidator((d) => auth.extend({ id: z.string().uuid(), action: z.enum(["pay", "reject"]), txHash: z.string().max(200).optional(), reason: z.string().max(300).optional(), refund: z.boolean().optional(), auto: z.boolean().optional() }).parse(d))
  .handler(async ({ data }) => {
    const { admin } = await ctx(data.initData);
    const r = await (await import("./payout.server")).reviewWithdrawal({ id: data.id, action: data.action, adminId: admin.id, txHash: data.txHash, reason: data.reason, refund: data.refund, auto: data.auto });
    await logAdmin(admin.id, `withdrawal.${data.action}`, data.id, data.reason);
    return { ok: true, txHash: r.txHash };
  });

// Settings: whitelist of keys, upsert, then invalidate the cache. ALL switches below are saved through this one function.
export const adminSaveSettings = createServerFn({ method: "POST" })
  .inputValidator((d) => auth.extend({ settings: z.record(z.string(), z.union([z.number(), z.string().max(2000)])) }).parse(d))
  .handler(async ({ data }) => {
    const { db, admin } = await ctx(data.initData);
    const allowed = [
      "deposit_rate_gems_per_usd", "withdraw_rate_gems_per_usd", "min_deposit_usd", "min_withdraw_gems", "min_collect_gems", "welcome_bonus_gems",
      "ref_bonus_gems", "ref_mage_pct", "ref_magic_pct", "magic_burn_per_gem_earned",
      "withdrawals_open", "withdraw_bep20_open", "withdraw_gram_open", "withdrawal_fee_type", "withdrawal_fee_value", "free_withdrawal_cap_usd", "min_account_age_hours",
      "deposits_open", "auto_deposit", "dep_coin_GRAM", "dep_coin_USDT", "dep_coin_BNB", "dep_coin_ETH", "dep_coin_USDC", "dep_chain_eth", "dep_chain_bsc", "dep_chain_ton",
      "ton_address", "memo_prefix", "autopay_enabled", "autopay_bep20", "autopay_gram", "autopay_max_usd", "autopay_max_times", "autopay_min_deposit",
      "max_new_accounts_per_ip", "ip_retention_days", "join_channel", "join_payment_channel", "join_channels_extra", "promo_popup_text", "promo_popup_enabled",
    ]; // never allow cron_key here
    const rows = Object.entries(data.settings).filter(([k]) => allowed.includes(k)).map(([key, value]) => ({ key, value }));
    await db.from("app_settings").upsert(rows);
    (await import("./core.server")).invalidateSettingsCache();
    await logAdmin(admin.id, "settings.save", rows.map((r) => r.key).join(","));
    return { ok: true };
  });
```

Implement the remaining functions with the same shape and behaviour as OminiAi (names identical): `adminSearchUsers`, `adminGetUser`, `adminUpdateUser`, `adminManualDeposit`, `adminAddAdmin`, `adminRemoveAdmin`, `adminWithdrawals`, `adminFreezeWithdrawal`, `adminDeleteWithdrawals`, `adminDeposits`, `adminFrozenUsers`, `adminUnfreeze`, `adminInspectAddress`, `adminGetSettings`, `adminBroadcast` (batches of 50 / 25 parallel / 1 s pause / 429 retry / `broadcasts` log), `adminSetupWebhook`, `adminSuspicious`, `adminBulkBan`, plus new `adminSaveMages`, `adminSaveMagicPacks`.

On/off switch UI (used for Withdrawals, per-method, deposits, auto deposit, autopay; same component everywhere):

```tsx
function SwitchRow({ k, label, cfg, onSave }: { k: string; label: string; cfg: Record<string, unknown>; onSave: (k: string, on: boolean) => Promise<void> }) {
  const on = String(cfg[k] ?? "on") !== "off";
  return (
    <div className={`${card} flex items-center gap-3`}>
      <p className="flex-1 font-semibold">{label}: {on ? <span className="text-success">OPEN</span> : <span className="text-destructive">CLOSED</span>}</p>
      <button disabled={on} onClick={() => onSave(k, true)} className={`${btn} bg-success`}>Open</button>
      <button disabled={!on} onClick={() => onSave(k, false)} className={`${btn} bg-destructive`}>Close</button>
    </div>
  );
}
// Settings tab → "Deposits" card: SwitchRow for deposits_open, auto_deposit, dep_coin_*, dep_chain_*.
// Withdrawals tab → SwitchRow for withdrawals_open, withdraw_bep20_open, withdraw_gram_open.
// Autopay tab → autopay_enabled, autopay_bep20, autopay_gram (default "off") + the three numbers.
```

## 18. Environment, cron, deploy (same as OminiAi)

- **Secrets (server env only):** `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TG_ID` (comma-separated owner ids), `MNEMONIC` (deposit addresses), `PAY_WALLET_SECRET` (BEP20 payout wallet), `TON_WALLET_SECRET` + `PAY_TON_ADDRESS` (GRAM payout wallet), `ETH_API`, `BSC_API` (NodeReal keys), `TON_API_KEY`, `PAY_TONCENTER_API`, `FP_SALT`, `IP_SALT`. Use separate wallets for deposits (MNEMONIC) and payouts; keep only what is needed for payouts in the payout wallets.
- **Cron:** POST `/api/public/cron/scan-deposits` with header `x-cron-key: <app_settings.cron_key>` every 1 minute (Cloudflare Cron Trigger or cron-job.org). Add a cleanup cron that deletes `ip_ban` rows older than `ip_retention_days` (except active bans) and old `rate_limits`.
- **Health:** `GET /api/public/health` (DB reachable, settings readable, last cron time) and `GET /api/public/prices-check`.
- **After publish:** open `/admin` → Settings → set GRAM deposit address + memo prefix, rates, switches → **Connect bot** → add the bot as admin of every join-gate/payment channel → test: deposit $1 in each coin, check credited gems, test a withdrawal (manual pay, then autopay), test ban/unban.

---

## 19. Delivery checklist

1. `AGENTS.md` updated (section 0). `style.css` has both required rules.
2. All screens in section 3 match the reference layout; 12 mages; locked silhouettes; EN/RU/ZH/AR.
3. Deposit flow works: coin → chain → page; native coins skip the chain step; admin switches (`deposits_open`, `auto_deposit`, per coin/chain) are honoured by UI **and** server.
4. Withdraw flow works: switches, per-method open/close, rules, bot alerts with buttons, manual pay, auto pay, reject/refund, banned never paid.
5. Admin has every tab/function listed in section 5 (OminiAi parity) plus Mages & Magic; every action is logged.
6. Security items in section 9 implemented and listed in `roadmap.md`; hashed fingerprint/IP; no hardcoded wallet addresses.
7. Reply with a short summary: what was built, what is still manual (set secrets, set cron key and schedule, connect bot, add bot as channel admin, fund payout wallets with USDT + BNB/TON for gas, publish).
