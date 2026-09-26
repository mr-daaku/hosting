# OminiAi — Update Prompt 6 (Confirmed Deposit Bug Fix + Withdrawal Channel Post)

Follow-up on `prompt.md` → `prompt5.md`. This one starts from a **confirmed root cause**, not a guess.

---

## 1. Confirmed Bug: `min_deposit_usd` is still seeded at $1

A real BSC test deposit was verified directly against NodeReal:

- Tx hash: `0x6611f9b34e6e1eaff89659dd25d2c2e3dbc02d809bf51587e08c189a8aaa1de0`
- From `0xf46a92c8e4504f4ff702aa96ca15d661422727af` → To `0x61ae4a22287633551de832335ecfa86af1450e5f`
- Asset: USDT (contract `0x55d398326f99059ff775485246999027b3197955`, matches the official BSC USDT contract), amount **0.11 USDT**
- The scan correctly finds and parses this transfer (contract match, decimals correct) — it is **not** a scanning/API bug.

The `deposits.server.ts` `credit()` function has:

```ts
if (usd <= 0 || (!opts.force && usd < Number(s.min_deposit_usd))) return null;
```

And the DB migration seeds `min_deposit_usd` at `'1'` (i.e. $1) — this was never lowered when the min-deposit rule was changed in earlier prompts. Since $0.11 < $1, the deposit is silently discarded: nothing is inserted into `deposits`, no notification, no error — the user just sees "No deposit found."

### Fix
- **Update the `min_deposit_usd` setting's actual stored value to `0.01`** (not just the code's fallback/default — the row already in `app_settings` for this key must be updated to `0.01`), and confirm the admin Settings screen reads/writes this same key.
- Re-verify after the fix that the real test deposit above ($0.11) gets picked up and credited on the next "Check Deposit" tap (it will not have been recorded yet, since the earlier attempt returned early before any DB insert — so this is a fresh, uncredited deposit once the threshold is fixed, not a dedupe conflict).

### Also fix: below-minimum deposits currently vanish with no trace
Right now, if a deposit's USD value is under `min_deposit_usd`, `credit()` returns `null` **without inserting anything** — so even the admin has no record it ever happened, and the user gets a generic "No deposit found" message that's misleading (the deposit *was* found, it just didn't qualify). Change this to:
- Still insert a row into `deposits` with a status like `below_minimum` (no coins credited, but the tx hash + amount are recorded, dedup'd by tx hash like any other row).
- Return an informative result on `checkDeposit` distinguishing "found something, but below minimum" (with the required minimum shown) from a genuine "nothing found yet" — the frontend should show the actual minimum to the user in that case rather than the generic no-deposit message.

---

## 2. Withdrawal "Paid" → Post to Payment Channel

When an admin marks a pending withdrawal as **Paid** (from the Withdrawals tab, `prompt2.md` §8 / `prompt.md` §11), also post a message to the configured **Payment Channel** (the same channel field from `prompt5.md` §3):

- Message content: masked user details (Telegram ID and/or name, not full username if sensitive), amount, asset (always USDT per the withdrawal restriction), chain (BEP20/TON), and a **tx link** (BscScan/Tonviewer link built from the tx hash the admin entered when approving).
- HTML-formatted, matching the app's existing bot-message styling.
- If no Payment Channel is configured, skip posting silently (same "optional unless configured" rule as `prompt5.md` §3) — don't error out the approval flow.

---

## What to test after this is deployed

1. **Settings check:** Open Admin → Settings and confirm Minimum Deposit now shows `0.01`, not `1`.
2. **Re-check the known deposit:** In the app, on the BSC USDT deposit page for this test account, tap **Check Deposit**. It should now find and credit the existing 0.11 USDT deposit (tx `0x6611f9b3...aaa1de0`) — confirm: coin balance increases by the right amount (0.11 USDT × coin_rate), a bot DM arrives with that tx hash, and `total_deposit` goes up by $0.11.
3. **Duplicate-tap check:** Tap **Check Deposit** again right after — it must NOT credit the same tx a second time (dedup by tx hash).
4. **New tiny deposit:** Send a fresh, smaller test amount (e.g. under $0.01) and confirm it now shows the improved "below minimum, minimum is $0.01" message instead of a plain "no deposit found," and that it's still recorded (status `below_minimum`) so the admin can see it happened.
5. **Withdrawal channel post:** Submit a test withdrawal, have admin mark it Paid with a tx hash, and confirm a message with the tx link appears in the configured Payment Channel (and confirm nothing breaks/errors if no Payment Channel is set at all).
6. **ETH sanity check:** Since the bug was in a shared threshold setting (not chain-specific code), do one small real ETH deposit too, to confirm it's equally fixed there.
