# MagiqAi — Prompt 1 (full build)

> Read this whole file before writing code. Do the work in the order given. Where this file and an old habit disagree, this file wins.

## 0. FIRST: save memory in AGENTS.md

Before coding, create/update `AGENTS.md` (project root) with the rules below, so you remember them in every later prompt. Keep each as a short line with a "Why".

- Project: **MagiqAi**, Telegram Mini App, bot **@MagiqAiBot**. Fantasy mage game; users buy mages that earn gems every day; deposits/withdrawals in crypto; referral program; full admin panel.
- Architecture = same as the OminiAi project (`ominiaibot-main`): TanStack Start server functions, Supabase (service-role only on server), Cloudflare Workers hosting, Telegram webhook, admin inside the same app. Reuse its modules (`tonpay`, `deposits`, `payout`, `telegram`, `wallet`, `core`, `admin.functions`) instead of rewriting.
- Security source of truth: `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/security.md`. Re-read it before every feature that touches auth, money, admin, logs or data collection. Why: user's rule.
- Design reference assets live in `https://github.com/mr-daaku/hosting/tree/main/MagiqAiBot/images` (raw base: `https://raw.githubusercontent.com/mr-daaku/hosting/main/MagiqAiBot/images/`). Why: single place for logo + screenshots.
- `style.css` / global CSS must always contain (never remove):
  ```css
  #lovable-badge { display: none !important; }
  .safe-bottom { padding-bottom: calc(max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)) + 0.75rem); }
  ```
- Prompt links: when the user sends just "Hii", open the next prompt file (last was promptN → read promptN+1 at `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/`); if missing, read the highest-numbered prompt in that folder. Why: user's request.
- Live prices load in the browser first; server crediting falls back to Coinbase then OKX (Binance/CoinGecko block the cloud server). Same as OminiAi.
- One account per device, banned-IP and bot-account rules (section 9). Why: anti multi-account.
- Never store seed phrases, bot token, raw initData, or full request bodies. Never log secrets.
- Keep `roadmap.md` updated: tick each prompt/feature when done.

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

### 3.3 Deposit
- Coin selector card (opens "Choose a coin" modal): **GRAM** and **USDT**, each with live USD price. USDT supports the same networks as OminiAi (BEP20 and USDT-GRAM) via a network chooser.
- Amount (USD) input, live preview: "You get: N gems · Amount: X GRAM".
- **Top up** button → shows address (+ memo for GRAM) exactly like OminiAi deposit flow, plus "Check deposit".
- Rate defaults: **$1 = 5,000 gems**. Minimum deposit $1.00 (= 5,000 gems). Rate and minimum are admin settings.
- History table: Date · Method · Sum · Status ("Nothing here yet." when empty).
- Promo popup (dismissable ✕) is admin-editable text. Default text must be neutral, e.g. "Top up with GRAM or USDT. Earnings from mages are estimates and are not guaranteed." Do **not** use wording like "safe", "trusted by global traders", "guaranteed", or "start investing".

### 3.4 Withdraw
- Two cards: GRAM and Tether USD, showing **Minimum (gems): 10,000** and **Minimum (USD): $1.00** (fix the reference app's duplicated "Minimum" label).
- Withdraw rate default: **10,000 gems = $1** (admin setting, separate from deposit rate).
- Tapping a coin opens address + amount form. Rules: 24h between withdrawals, account-age gate, fee (flat/percent), free cap without deposit, pending → admin review or autopay (reuse OminiAi logic).
- History table: Date · Method · Sum · Status.

### 3.5 Partners
- Top card: referral earnings pending (gem icon + number) with **Collect** button; referral link `https://t.me/MagiqAiBot?startapp=<ref>` with **Copy** button.
- Three info tiles: **10%** of partner's mage purchases · **12%** of partner's Magic purchases · **25 gems** per invited partner. Footnote: "* Multi-accounts are not paid."
- Stats: Partners (count), Total income (gems).
- Table: Date · User · Deposit · Income (user shown as masked @username).
- All percentages/bonuses are admin settings and calculated **on the server**. Referral rewards are credited only after the partner passes the anti-abuse checks (section 9).

### 3.6 Profile
- User ID card, **Payments — History of replenishments [Open]**, **Withdrawal of funds — Withdrawal history [Open]**.
- Language selector (EN/RU/ZH/AR).

## 4. Economy settings (all in admin Settings, cached per worker, invalidate on save)

`deposit_rate_gems_per_usd (5000)`, `withdraw_rate_gems_per_usd (10000)`, `min_deposit_usd (1)`, `min_withdraw_gems (10000)`, `min_collect_gems`, `welcome_bonus_gems`, `ref_bonus_gems (25)`, `ref_mage_pct (10)`, `ref_magic_pct (12)`, `magic_burn_per_gem_earned`, mage table (price, pct, gems/day, enabled), magic packs table, withdrawal fee type/value, free withdrawal cap, `min_account_age_hours`, `max_new_accounts_per_ip` per hour, promo popup text, join-gate channels, deposit addresses + memo prefix, autopay options.

## 5. Admin panel (reuse everything from OminiAi, same tabs)

Same `/admin` route, owner = `OWNER_TG_ID` (server secret), extra admins managed in Settings:

**Dashboard · Users · Withdrawals · Frozen · Deposits · Check Deposit · Broadcast · Autopay · Settings** + a new **Mages & Magic** tab.

- **Dashboard**: total users, banned, new in 24h, pending withdrawals, total gems in circulation, deposits/withdrawals (all + today), profit (all + today) — summed in SQL (`admin_totals`).
- **Users**: search by ID/@username, open user (balance, mages owned, referrals, status), edit balance/mages with reason, ban/unban, manual deposit, **Suspicious** view (last 7 days, live, with multi-select **Bulk ban** that rejects + refunds pending withdrawals).
- **Withdrawals**: filter by status, approve/reject (with reason + refund), freeze, delete paid/rejected, stats.
- **Frozen**: list + unfreeze.
- **Deposits / Check Deposit**: list incl. below-minimum deposits, inspect address/tx, re-scan.
- **Broadcast**: 50-per-batch send with result summary.
- **Autopay**: on/off, BEP20 on/off, GRAM on/off, max amount, max paid times, min total deposit.
- **Settings**: all values in section 4, join gate (channel, payment channel, extra channels; bot must be channel admin), admins list, **Connect bot (setup webhook)** button.
- **Mages & Magic (new)**: edit mage prices/percentages/enabled, edit magic packs, upload/replace mage images, preview shop.
- Every admin action is written to an `admin_actions` log (actor, action, target, reason, time). No secrets in logs.

## 6. Data model (Supabase, RLS on, no client access)

Minimal tables: `users`, `user_mages (user_id, mage_id, qty, last_accrual_at)`, `ledger` (append-only, idempotent, unique external tx key), `deposits`, `withdrawals`, `referrals`, `settings`, `admins`, `device_ban`, `ip_ban`, `rate_limits`, `admin_actions`. All money changes go through atomic SQL functions (`SECURITY DEFINER`, service_role only) that write balance + ledger together. Do **not** recreate retired OminiAi tables (`wallets`, `device_fingerprints`, `transactions`). Boot = one server call (`getMe` → `boot_user` RPC).

## 7. Payments

Reuse OminiAi deposit scanning: GRAM (raw `wc:hex` comparison, memo = `memo_prefix + tg id`), USDT-GRAM (trace id as tx key), USDT BEP20 (per-user derived address from `wallet_index`, no wallet rows). Credit only after backend verification of network, token, destination, amount, confirmations. Webhook/cron endpoints verify secrets. Never credit from a client callback.

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

## 11. Delivery checklist

1. `AGENTS.md` updated (section 0).
2. `style.css` has the two required rules.
3. All screens in section 3 match the reference layout; 12 mages; locked silhouettes; EN/RU/ZH/AR.
4. Admin tabs working incl. Mages & Magic.
5. Security items in section 9 implemented and listed in `roadmap.md`.
6. Reply with a short summary: what was built, what is still manual (set secrets, connect bot, add bot as channel admin, publish, re-run **Connect bot**).

build in one turn and verify after build app.
