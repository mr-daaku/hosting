# OminiAi — Update Prompt 2 (Fixes + New Rules)

This is a **follow-up change list** on top of the already-built OminiAi app (and supersedes a few rules from the original `prompt.md` where noted below). Implement **every item below, completely, in one pass** — nothing should be skipped or left half-done.

---

## 1. Layout / Overflow Fixes (Home page)

- The **"Estimated income"** block (`$X/hr`, `$X/day`, `$X/mo`) currently renders too large and overflows the screen width, breaking the page layout. Shrink this text (smaller font size, wrap/truncate long decimals if needed) so it always fits inside its card on all screen widths.
- The **mining/yield number** (long decimals like `0.00000172`) also overflows off-screen. Shrink its font size and/or truncate to a sane number of decimals (e.g. 6–8 max) so it never breaks the layout.
- **Bottom navigation bar must always stay fixed** at the bottom of the screen, regardless of how much content is on the page or how any card overflows — it must never get pushed off-screen or scroll away.
- **Top safe-area fix:** in Telegram's fullscreen mode, the top row (online-count pill, dropdown, menu icon) currently renders too high and overlaps the device status bar/notch. Push all top text and buttons **down** using `padding-top: env(safe-area-inset-top, 0px)` (or the Telegram WebApp safe-area API) so nothing sits under the system status bar in fullscreen.

---

## 2. Account Page — Build Out Fully

The Account/Profile page currently has almost nothing on it. Rebuild it to match the reference design (screenshot provided) with **all** of the following cards/sections:

- Profile header: avatar, display name, Level badge
- Total balance (USDT)
- "Invited by" card — shows the referrer's Telegram ID (or "—" if none)
- Coin balance card
- USDT balance card
- Referral income card (total USDT earned from referrals)
- Referral coins card (total coins earned from referrals)
- USDT withdrawn card (lifetime total)
- Language setting (default English)
- Theme toggle (Dark/Light)
- Operations / History (link to full transaction history)
- FAQ (link/section with answered questions)
- **Legal page link** at the very bottom of this page (see §9 — required so Lovable doesn't block the build for missing a legal/policy page)

---

## 3. "Legal" Tab → "Trade" Tab (real chart only, no fake trading UI)

**This supersedes the "AI Trading Demo" section from the original `prompt.md`.** Do **not** build a simulated trade feed, fake AI chat log, or a displayed "success rate" — Lovable's own safety review flags that kind of fabricated trading activity as a scam pattern and refuses to build/ship it.

Instead:
- Rename/replace the existing "Legal" bottom-nav tab with a **"Trade"** tab.
- Trade tab shows a **BTC market view with real charts only** — e.g. an embedded TradingView widget or live price chart sourced from a real public API (CoinGecko/Binance public market data), showing real BTC/USDT price action.
- No fake buy/sell log, no fabricated win-rate stat, no simulated bot commentary. Purely a read-only, real market chart.
- The actual Legal/Terms & Privacy content moves to its own page linked from the bottom of the Account page (§2, §9) instead of being a main tab.

---

## 4. Fullscreen Mode

Add the Telegram Mini App fullscreen script/call so the app always opens in full-screen mode (`Telegram.WebApp.requestFullscreen()` on load, with `expand()` as a fallback for older clients), combined with the safe-area fix in §1.

---

## 5. "Online" Counter — Realistic Random Drift

Replace the static online-count number with a **randomized live counter**:
- Random value in the range **600–2200**.
- Re-randomizes (small drift up/down from the current value, not a full jump) **every 30 seconds**, purely client-side/cosmetic — no real user-count query needed.

---

## 6. App Deep Link Change

Change the Mini App link everywhere it's used (bot `/start` button, referral links, any shared link) from:

```
https://t.me/OminixAiBot/ai
```

to:

```
https://t.me/OminixAiBot/Trade
```

The referral `startapp` query param stays the same format: `https://t.me/OminixAiBot/Trade?startapp={userid}`.

---

## 7. In-App Notifications (toast style)

Restyle the in-app pop-up/toast notification (the one that slides in from the top) so it visually matches OminiAi's own theme/branding (colors, font, corner radius, icon) instead of a generic default toast style.

---

## 8. Deposit & Withdrawal Rules

### Minimum amounts (admin-editable in Settings)
- **Minimum deposit:** default **$0.1** (= 10 coins at the 100x rate)
- **Minimum withdrawal:** default **$0.1**

### Free withdrawal allowance
- A user who has **never deposited** can still withdraw, but only up to a lifetime cap of **$0.25 total** in "free" withdrawals.
- Once a user has withdrawn $0.25 cumulatively without ever depositing, block further withdrawals and show a message telling them to deposit first.
- This cap and its $0.25 value must be admin-editable.

### Withdrawal payout chains — restricted
- Users may only withdraw to a **USDT BEP20 address** or a **USDT TON address** (remove all other chain options from the withdrawal screen — no BTC/ETH/TRX/SOL native payouts).
- Regardless of which chain the user withdraws to, the payout amount is always expressed and sent as **USDT** — never any other native coin.

### Deposit/Withdraw navigation
- On both the Deposit page and the Withdraw page, add a **"Back" button** that returns the user to the previous step (chain/coin selection), not just a full close.

### Deposit conversion display
- When a user selects a **native coin** (ETH, BNB, MATIC, TRX, SOL, TON) to deposit, show all three values together on that screen: **1 [native coin] = X USDT = Y coins** (live conversion, using the current price feed).
- Deposit crediting order: native coin amount → convert to **USDT** (live price) → convert USDT to **coins** (100x rule) → credit to user's account. Store both the USDT-equivalent and the coins-credited on the deposit record.

### Deposit page button
- Replace the **"Open App"** button on the deposit page with an **"Open Wallet"** button — it should deep-link/open the user's crypto wallet app so they can send the deposit directly from there.

### Stablecoin authenticity check
- When a deposit comes in as USDT or USDC, verify the **token contract address** on-chain matches the real, official USDT/USDC contract address for that chain before crediting it.
- If the contract address does not match the official one, **do not credit the deposit** — notify the user in-app and via bot message that a fake/unofficial USDT or USDC token was detected and wasn't accepted.

---

## 9. Legal Page (required by Lovable)

Add a proper Legal / Terms & Privacy page, linked from the bottom of the Account page (§2). Without this, Lovable's build safety check refuses to ship the app. Standard sections: Terms of Service, Privacy Policy, Risk Disclosure (mentions this is a rewards/coin app, not financial advice), Contact.

---

## 10. Daily Yield — Replace Flat Rate with Tiers

**This replaces the flat "0.02% daily" rule from the original `prompt.md`.** Daily USDT yield now depends on the user's coin balance, tiered:

| Tier | Coin balance range | Daily rate |
|---|---|---|
| T1 | 100 – 1,000 | 2.0% |
| T2 | 1,000 – 5,000 | 4% |
| T3 | 5,000 – 20,000 | 6% |
| T4 | 20,000 – 30,000 | 7.5% |
| T5 | 30,000+ | 10% |

- The user's daily USDT yield = their current coin balance × the rate for the tier their balance falls into.
- All tier thresholds and rates must be stored in `app_settings` and be admin-editable (add/remove/edit tiers, not just hardcoded 5 rows).

---

## 11. Admin Panel — Users Tab Behavior

- The Users tab must **not** auto-load or list any users when the admin opens it. It should show **empty/blank until the admin searches** for a specific user (by Telegram ID, username, or name).

---

## 12. Admin Panel — Manual Deposit Tool (separate from Adjust Balance)

On a searched user's detail view, add a **"Deposit"** action distinct from the existing "Adjust Balance" tool:
- Admin enters: **tx hash**, selects **native coin or stablecoin**, and the amount.
- This runs through the normal deposit-crediting pipeline (§8 conversion order) and **inserts a row into the `deposits` table keyed by that tx hash**, exactly like an automatic deposit would.
- Purpose: if the automatic on-chain detection fails/is down, admin can manually credit the user's deposit. Because it's recorded by tx hash like any other deposit, when the automatic system later comes back online and finds that same tx hash, it must **skip it** (already-dedup'd) instead of crediting it a second time.

---

## 13. Admin Panel — Freeze Balance

Add a **"Freeze balance"** control on the user detail view:
- Admin sets a frozen amount for that user.
- The frozen amount is excluded from what the user is allowed to withdraw (available-to-withdraw = balance − frozen), but still shows as part of their total balance.
- Frozen amount and reason should be visible/editable from the same panel.

---

## 14. Admin Panel — Admin Management List

In Settings, show the **full list of current admins** (Telegram IDs/names) with:
- Add new admin (by Telegram ID)
- Remove existing admin
This should be a proper managed list in the UI, not just a raw text field.

---

## 15. Notifications on Key Actions

On each of the following events, send the user a bot DM message:
- **Deposit confirmed** — include the tx hash
- **Referral reward earned**
- **Withdrawal processed** — include the tx hash
- **Daily profit claimed**

---

## 16. Gift — One-Time Only

- Each user may claim the random coin gift **only once ever** (not repeatable/daily). Once claimed, the Gift button/section should show as already-used for that account.
- Remove the literal text **"Open a gift for 1–10 coins"** from the UI — don't reveal the exact reward range to the user; keep the button copy generic (e.g. just "Open Gift").

---

## Summary — do not skip anything

This list touches: layout/overflow (§1), Account page rebuild (§2), Trade tab replacing fake trading demo (§3), fullscreen (§4), online counter (§5), deep link rename (§6), toast styling (§7), deposit/withdrawal rules and restrictions (§8), Legal page (§9), tiered daily yield replacing the flat rate (§10), admin Users tab search-only behavior (§11), admin manual deposit tool (§12), admin freeze balance (§13), admin admin-list management (§14), bot notifications with tx hashes (§15), and one-time gift with hidden reward text (§16). Implement all of it in this pass.
