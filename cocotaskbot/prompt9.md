# CoCo/Credit App — prompt9.md

Client (SoYKoT) feedback, several items — please do all together.

---

## 1. Referral link path change

`referral.tsx` currently builds: `` `https://t.me/MyTelegramTaskBot/app?startapp=${userId}` ``

Change the path segment from `/app` to `/Myapp`:
`` `https://t.me/MyTelegramTaskBot/Myapp?startapp=${userId}` ``

**Please also confirm** the Mini App's short name registered with @BotFather for this bot actually matches `Myapp` — if BotFather still has it registered under a different short name (e.g. `app` or `Miniapp`), this link will fail to open even though the code is correct. Update it in BotFather if needed so the two match.

## 2. Unwanted ads firing on Daily Check-in, Promo Code claim, and first app open

Reported: claiming Daily Check-in shows a Monetag ad, claiming a promo code shows an Adsgram ad, and opening the app for the first time shows a 15-second Adsgram ad — none of which should show any ad at all.

**Code review finding:** `index.tsx`'s check-in handler (`claimDaily("checkin")`) and promo-claim handler (`claimPromo(code)`) don't reference `AdsPanel`, `useMonetag`, or `useAdsgram` anywhere — and `AdsPanel` (where the ad SDKs are used) is only imported/rendered on `spin.tsx` and `earn.tsx`. There's also no app-open/first-load ad trigger anywhere in the app code. So **this isn't the app calling an ad on those actions** — it points to the ad network side instead:

- The Adsgram block ID currently in use is `int-45849` — the `int-` prefix typically denotes an **Interstitial** ad unit on Adsgram's dashboard, not a **Rewarded** unit. Interstitial units are often configured to auto-display at their own discretion (app open, periodic intervals, certain interactions) independent of any explicit `show()` call in the code — which would explain exactly this symptom (ads appearing on actions that never call the ad SDK).
- **Please check the Adsgram dashboard for this block/zone**: confirm whether it's set to auto-show/interstitial behavior. If so, either switch it to a strict **Rewarded** unit (only shows when `show()` is explicitly called — the intended behavior for the Watch Ad buttons on Spin/Earn) or create a separate Rewarded-type block ID and use that instead of `int-45849` for the in-app "Watch Ad" buttons.
- Do the same check on the **Monetag** side for the configured zone ID — confirm it's a rewarded/on-demand format, not an auto-interstitial one.
- After switching to confirmed on-demand/rewarded units on both networks, re-test: Daily Check-in, Promo claim, and app open should show **zero** ads; only the explicit "Watch ad" buttons on Spin and Earn should ever trigger one.

## 3. Add a Delete option for promo codes (admin → Promo tab)

Add a **Delete** action (with the same confirm-dialog pattern used for task/withdrawal deletes elsewhere) for each promo code in the admin Promo list — currently there's Activate/Deactivate and viewing Claims, but no way to remove a code entirely.

## 4. Deposit memo prefix: `CC-` → `MTT-`

Change the memo prefix used everywhere from `CC-{userid}` to **`MTT-{userid}`** (matching the new bot identity, "My Telegram Task"):
- `coco.functions.ts` line ~651 and ~963: `` `CC-${...}` `` → `` `MTT-${...}` ``
- Any UI text referencing the old format — e.g. the admin Deposits search tab's placeholder/example text ("Search by memo or user ID" → placeholder `CC-123456 or 123456`, helper text "Memo is always CC-{user id}...") — update all of these to the `MTT-` format.
- The deposit flow's TonConnect transaction comment (built via `beginCell()...storeStringTail(...)`) must also use the new `MTT-{userid}` memo.
- This does not need to be backward compatible with old `CC-` deposits — just switch the format going forward.

## 5. Admin setting: cooldown between ad watches

Add a new admin-editable setting — something like **"Seconds between ad watches"** — controlling how long a user must wait after watching one ad before the next "Watch ad" button becomes available again (separate from the existing per-day ad-count limits already in Settings). Enforce it both client-side (disable/countdown on the button) and server-side (reject a claim that comes in before the cooldown has elapsed), same pattern as other reward-eligibility checks.

## 6. New `/start` welcome message + 3 buttons

Replace the current welcome caption and single button with:

**Caption** (interpolate the user's actual Telegram first name/username in place of `[user Name]`):
```
🚀 Welcome [user Name]!
Earn rewards easily by completing simple tasks, watching ads, spinning the daily wheel, and inviting your friends!
💰 Fast & secure withdrawal anytime.
Start earning today! ✨
```

**3 inline buttons** (replacing the current single "Open App" button):
1. **Channel** → `https://t.me/MyTelegramTask`
2. **Chat** → `https://t.me/MyTelegramTaskChat`
3. **Open Miniapp** → the Mini App link using the updated path from §1 (`https://t.me/MyTelegramTaskBot/Myapp?startapp=...` where relevant, or the bare app open link if no referral context)

Keep sending this along with the newly generated welcome image from the last update.

## 7. Admin Users tab — show the Telegram username

When an admin searches for and finds a user, show their **Telegram username** (e.g. `@handle`) in the result card alongside the existing ID/Credit/Gram/withdrawal details — currently only an internal display name and numeric ID show, not the actual `@username`.

## 8. Daily resets — fixed at 00:00 UTC, not rolling 24h

Change daily task completion (Check-in, Share With Friend, Check Updates) and daily ad-watch counters so they reset at a **fixed 00:00 UTC boundary every day**, rather than "24 hours since the user's last action" (the current rolling-window behavior). This means every user's daily allowance resets at the same moment (midnight UTC), not at a different time per user based on when they last claimed.

---

**Before finishing:** confirm the referral link now uses `/Myapp` and that path is actually registered in BotFather; confirm no ad shows on Daily Check-in, Promo claim, or first app open after the Adsgram/Monetag format check; confirm promo codes can be deleted; confirm every memo (deposit generation, TonConnect transaction comment, admin search UI text) uses `MTT-{userid}`; confirm the new ad-watch cooldown setting exists and is enforced server-side; confirm `/start` sends the new caption with 3 buttons (Channel/Chat/Open Miniapp); confirm admin user search shows the Telegram username; confirm daily resets happen at a fixed 00:00 UTC for every user, not per-user rolling windows.
