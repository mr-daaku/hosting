# CoCo App → Credit — prompt6.md

Five things — please do all of them together, then **deploy the edge/backend** after.

---

## 1. Spin admin — reward value AND probability, both editable

Found the exact cause: in `src/lib/spin-settings.ts`, `DEFAULT_SPIN_SEGMENTS` fixes each segment's reward `value` to its array index (0–6), and `normalizeSpinSegments()` only ever reads back a `weight` from saved settings — it **discards any custom `value`** and always re-maps to the fixed index-based value. That's why the admin section is literally titled "Spin probability weights" with a fixed `${segment.value} CoCo` label — the reward number itself was never actually editable, only its odds were.

Fix:
- In `spin-settings.ts`, change `normalizeSpinSegments()` to also read back and preserve a saved `value` per segment (matched by array position/id, not by the old value), falling back to the default only when nothing is saved yet.
- In `admin.tsx`'s spin section (around the `spinSegments.map(...)` block), add a second input next to the existing weight input — **"Reward (CoCo)"** — editable, alongside the existing **"Weight"** input. Update the label to reflect both, not a fixed `${segment.value} CoCo` heading.
- Confirm the actual spin draw (`spinFn` in `coco.functions.ts`, and the wheel rendering in `spin.tsx`) both read `segments[i].value` from these saved settings (they already do — `spinFn` already uses `normalizeSpinSegments(settings.spinSegments)` correctly) so once `value` is preserved through normalization, the credited reward and the displayed wheel will automatically match whatever the admin saved — no other changes needed there.

## 2. Admin — Delete button doing nothing on task cards (root cause found)

Found the exact cause in `admin.tsx`'s `AdminTaskCard`:

```tsx
<AlertDialogTrigger asChild>
  <ActionButton size="sm" variant="destructive" className="flex-1" onAction={() => undefined}>
    <Trash2 className="size-4" aria-hidden /> Delete
  </ActionButton>
</AlertDialogTrigger>
```

`ActionButton`'s own `onClick` handler unconditionally calls `e.preventDefault()` on every click (see `ActionButton.tsx`). Radix's `AlertDialogTrigger asChild` merges its "open the dialog" click handler with the child's `onClick` using `composeEventHandlers`, which **skips its own handler if the child already called `preventDefault()`**. So the dialog never opens — the button visually looks clickable but produces zero response, exactly as reported. This is a well-known Radix + custom-button gotcha, not a task-status-specific bug (it likely affects every Delete button, Running just happened to be where it was tested/noticed).

**Fix:** don't use the async-wrapping `ActionButton` as the `AlertDialogTrigger`'s child — it's just meant to open the dialog, not run an async action (the real delete action already correctly lives in `AlertDialogAction`'s `onClick` further down). Replace it with the plain `Button` component instead:

```tsx
<AlertDialogTrigger asChild>
  <Button size="sm" variant="destructive" className="flex-1">
    <Trash2 className="size-4" aria-hidden /> Delete
  </Button>
</AlertDialogTrigger>
```

Search the rest of `admin.tsx` (and anywhere else in the app) for the same pattern — `ActionButton` used as an `AlertDialogTrigger`'s (or any Radix trigger's) `asChild` child — and apply the same fix everywhere it appears, since it'll cause the identical silent-failure bug.

## 3. Monetag "Network error" — switch to the official Telegram Mini App SDK

The current integration loads the generic web script (`//libtl.com/sdk.js`) and calls a `show_{zoneId}()` global function. This is Monetag's older general-web method — for Telegram Mini Apps specifically, Monetag now provides a dedicated SDK built for the Telegram WebView environment, which is far more reliable there (the generic web script commonly throws exactly this kind of network/load error inside Telegram's in-app browser).

Switch to Monetag's official **`monetag-tg-sdk`** npm package:

```bash
npm install monetag-tg-sdk
```

```tsx
import createAdHandler from 'monetag-tg-sdk';

const adHandler = createAdHandler(MONETAG_ZONE_ID); // from the existing server-provided config/secret

async function watchMonetagAd() {
  try {
    await adHandler(); // resolves once the user watches the ad
    // credit the reward here (same server call already used for the reward)
  } catch {
    // ad failed/was skipped — show the existing fallback toast, don't reward
  }
}
```

Rebuild `useMonetag`/`MonetagCard` in `AdsPanel.tsx` around this `createAdHandler` pattern instead of the manual `<script>` tag + `show_{zoneId}` global lookup. Keep everything else (zone ID from secret, loading/disabled states, reward crediting call, daily watch limits) as-is — just swap the underlying SDK mechanism.

## 4. Rebrand: CoCo → Credit, new logos

- Rename the coin everywhere it's user-facing: **"CoCo" → "Credit"** — balance labels, task rewards, spin wheel labels, toasts/messages, bot messages, admin panel labels, etc.
- Leave internal/technical identifiers alone unless they'd break something visible — e.g. the deposit memo prefix (`CC-{userid}`) and internal `currency: "COCO"` enum values in the database can stay as-is; this is a **display-name rebrand**, not a schema migration. If there's an easy, low-risk way to also rename the internal currency code, that's a bonus, but the visible "Credit" label everywhere is the actual requirement.
- Generate a **new app logo** and a **new coin logo** for "Credit" (replacing the CoCo crystal-coin logo) — keep the same dark background + brand green `#BCE356` identity, just a fresh mark that fits the new "Credit" name instead of referencing "CoCo".

## 5. Moving the whole system to a new bot — reset test data

The whole CoCo/Credit system (this app, as-is) is being moved onto a different bot, **@MyTelegramTaskBot**, with a new channel (`https://t.me/MyTelegramTask`) and chat (`https://t.me/MyTelegramTaskChat`) replacing any old ones referenced in the app/bot messages. The bot token has already been swapped in the project's secrets — no need to ask for it again, just use whatever's currently stored there.

For this move (per the client, for testing):
- **Reset all user balances** (Credit/Gram) to zero.
- **Clear all withdrawal requests** (and their history).
- **Clear all deposit records/attempts.**
- Keep the app/database structure, settings, tasks, and admin configuration intact — this is a **data reset for a fresh test run**, not a rebuild. The fixed admin ID (`7206619137`) stays admin.
- Update anywhere in the app or bot messages that references the old bot username/channel/chat links to the new ones above.

---

**Before finishing:** confirm the spin admin section now has both a reward-value and a weight field per segment and that spinning actually pays out whatever value was saved; confirm the Delete button opens its confirmation dialog and deletes on every task tab (Pending/Running/Paused/Done); confirm Monetag ads actually play using the new SDK; confirm "Credit" appears everywhere "CoCo" used to, with new logos in place; confirm balances/withdrawals/deposits are wiped and the new bot's links are wired in. **Deploy the edge/backend once everything above is done.**
