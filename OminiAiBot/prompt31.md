# OminiAi — Update Prompt 31 (Security Hardening: Fake Accounts, Bots, Script Abuse)

This is a security pass to stop fake/bot accounts and scripted exploitation, based on an actual code review of the current app (not guesses) plus researched anti-bot/anti-farm practices used by other Telegram Mini Apps in 2026. Everything here is designed to use **as little extra database storage as possible** — short-lived counters and single-row-per-entity tables, never a growing log of every request.

---

## 1. Critical, Confirmed Bug: Device-Fingerprint Check Is Bypassable

In `getMe`, the fingerprint is an **optional** parameter:

```ts
const auth = z.object({ initData: z.string().min(1).max(8000) });
...
.inputValidator((d) => auth.extend({ fp: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(d))
...
if (data.fp && !(await isAdmin(user.id))) {
  await supabaseAdmin.rpc("check_device", { p_user: user.id, p_fp: data.fp });
}
```

**This is the main hole.** Because `fp` is optional, a script calling the server function directly (not through the real app's JS) can simply omit it — and the entire one-account-per-device anti-bot check is skipped completely, every time. This is almost certainly how bot farms are getting past the device-ban system you already built.

### Fix
- Make `fp` a **required** field on `getMe` (no `.optional()`).
- If `fp` is missing or doesn't match the expected 64-char hex format, **reject the request** (throw an auth error) instead of silently proceeding without the check.
- Keep the existing admin exemption, but otherwise there must be no code path where an account is created/loaded without a fingerprint being checked.

---

## 2. Shrink the initData Validity Window (replay-abuse reduction)

Currently:

```ts
if (Date.now() / 1000 - authDate > 7 * 86400) throw new Error("Telegram session expired, please reopen the app");
```

`initData` is valid for **7 days**. Since the real app fetches a fresh `initData` from `window.Telegram.WebApp.initData` on every open, there's no legitimate reason a 7-day-old one should still work — this long window is exactly what makes a captured/leaked `initData` string valuable to a script (it can be replayed thousands of times over a week).

### Fix
- Shrink the accepted `initData` age to a much smaller window — e.g. **1 hour** for balance-affecting actions (claim profit, open gift, withdraw, deposit check), and up to a few hours at most for read-only calls like `getMe`.
- This alone doesn't stop a live script with a fresh session, but it drastically cuts the value of any leaked/captured `initData`, and forces an attacker to keep re-generating fresh sessions, which raises their cost.

---

## 3. Lightweight Rate Limiting (per Telegram user ID + per IP)

Add a simple token-bucket limiter in front of the sensitive server functions (`claimProfit`, `openGift`, `requestWithdrawal`, `checkDeposit`, `getMe`):

- **Per Telegram user ID:** e.g. max 1 request per action per few seconds (prevents rapid-fire scripted calls / double-tap exploits).
- **Per IP address:** e.g. max N new-account creations per IP per hour (this is what actually throttles a bot farm, since many fake accounts tend to come from a small number of server/proxy IPs).

### Minimal storage design
Don't log every request. Use one of:
- An in-memory token bucket in the edge/worker runtime (resets naturally, zero DB rows), if the platform supports persistent-enough worker state, **or**
- A single upsert-and-expire row per `(user_id)` or `(ip)` key — e.g. `rate_limits(key text primary key, count int, window_start timestamptz)` — overwritten/reset each window, never appended to. This table should never grow past roughly one row per active user/IP, not one row per request.

---

## 4. IP Ban Table (same lightweight shape as the existing device-ban table)

You already have a clean, minimal pattern for this — `device_ban(device_fingerprint, user_id)`, one row per fingerprint. Add the same shape for IPs:

```sql
CREATE TABLE ip_ban (ip text PRIMARY KEY, banned boolean DEFAULT false, note text, created_at timestamptz DEFAULT now());
```

- Capture the request IP (from the platform's forwarded-IP header) alongside the fingerprint check in `getMe`.
- If an account gets banned for `duplicate device` or is flagged as a bot pattern (§6), also record/flag its IP here.
- On every `getMe`, check the IP against this table **in the same query/round-trip** as the fingerprint check (don't add a second DB round-trip) — if banned, reject immediately before any account is created.
- This stays small: one row per IP you've actually had to act on, not one row per visit.

---

## 5. Auto-Reject + Auto-Ban for Bot-Pattern Withdrawals

Right now, a banned account can presumably still have a withdrawal sitting in the `pending` queue for an admin to manually reject. Close this gap:

- If a user's account is `is_banned = true` (for any reason — duplicate device, admin ban, or a future bot-pattern flag) at the moment a withdrawal would be auto-paid or reviewed, **auto-reject it and refund the hold immediately** — never let a banned account's withdrawal sit in a state where it could still get paid by mistake (e.g. a race where the ban happens after the withdrawal request but before admin review).
- Extend the existing `check_device` ban trigger: if a newly-created account gets banned for duplicate device **after submitting a withdrawal within the same session**, immediately auto-reject that withdrawal and refund the hold, don't wait for a cron/admin pass.
- This logic can live entirely in the existing `check_device`-style Postgres function — no new tables needed, just an additional `UPDATE withdrawals SET status='rejected', reject_reason='banned account' WHERE user_id = p_user AND status = 'pending'` alongside the existing ban update.

---

## 6. Minimum Account Age Before First Withdrawal

Bot farms want to cash out fast. Add friction without storing anything new (you already have `joined_at`):

- Require an account to be at least **e.g. 6–24 hours old** (admin-editable) before its **first** withdrawal is allowed — this one setting alone meaningfully slows down farms designed to create-and-immediately-cash-out, with zero extra storage since it's computed from the existing `joined_at` column.
- This is in addition to, not instead of, the existing free-withdrawal-cap and 24h-between-withdrawals rules already in the code.

---

## 7. Admin "Suspicious Accounts" View (computed, not stored)

Give the admin panel a view that **flags** likely bot/farm accounts using patterns computed on read from data you already have — don't add new always-growing tracking columns:

- No `username` set **and** no referral activity **and** created within the free-withdrawal window
- Multiple accounts sharing the same `referred_by` created within seconds/minutes of each other
- Accounts that hit the free-withdrawal cap (`$0.25`) almost immediately after account creation
- Accounts sharing an IP already present in `ip_ban` for another user (§4)

Surface this as a filtered/sorted list in the existing admin Users tab (e.g. a "Suspicious" quick-filter), with a **bulk-ban** action so the admin doesn't have to search and ban one ID at a time.

---

## 8. Audit Every Balance-Mutating Endpoint for Double-Tap / Race Protection

The existing code already does this well in a couple of places — keep this pattern and make sure it's applied everywhere:

- `claimProfit` uses an optimistic update (`.eq("last_yield_at", me.last_yield_at)`) so two simultaneous claims can't both succeed — good, keep this pattern.
- `openGift` uses `.is("last_gift_at", null)` the same way — good, keep this pattern.
- Audit `requestWithdrawal`, the manual admin "Deposit" tool (`prompt2.md` §12), and any other balance-changing action to confirm each one has an equivalent guard (a conditional update keyed on the row's current state, not a plain read-then-write) so a script firing the same request twice in parallel can never double-credit or double-debit.

---

## Summary — do not skip anything

Fix the confirmed `fp`-bypass hole first (§1) — this is the main reason bots are getting through right now. Then: shrink the initData replay window (§2), add lightweight per-user/per-IP rate limiting (§3), add the IP-ban table mirroring the existing device-ban design (§4), auto-reject/auto-ban bot-pattern withdrawals (§5), require a minimum account age before first withdrawal (§6), give admin a computed "Suspicious Accounts" view with bulk-ban (§7), and audit every balance-mutating endpoint for double-tap/race protection (§8). All of this is designed to add at most a couple of small, bounded tables — nothing that grows per-request.
