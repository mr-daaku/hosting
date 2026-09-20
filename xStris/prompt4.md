# xStris bot: speed fix + deposit / QR / menu / branding overhaul

Read this whole file first, then implement every part. Do the parts in order (A to J). Keep the branch buildable after each part.

## 0. Ground rules

- The bot is a TanStack Start server route (`src/routes/api/public/telegram/webhook.ts`) running as a Worker. It is NOT a Supabase Edge Function. Supabase is only the database, so every `supabase-js` call is a network round trip (RT).
- Do NOT change: ledger RPCs (`xs_*`), RLS, migrations 0000-0003, secrets/env handling, Pay API routes, the website routes (`/`, `/developers`).
- Money-moving calls (`xs_create_withdrawal`, `xs_internal_transfer`, `xs_claim_cheque`, `xs_create_cheque`, `xs_credit_deposit`) always stay awaited and unchanged.
- Never invent contract addresses. Any token that is not verified stays unlisted (see part C).
- Telegram parse mode is HTML everywhere. Escape every DB or user string with `escapeHtml`.
- Inline-button labels cannot be bold or nested. "Bold coin names" applies to message text and captions only.

---

## A. Fix the slow replies

### Root causes found in the code (fix all)

1. **Serial round trips before the reply.** A tap on Deposit or Wallet currently runs: idempotency insert (DB) → `getUser` (DB) → `answerCallback` (Telegram) → `listBalances` (DB, then prices, then catalogue, one after another) → `editMessage` (Telegram). Each hop is sequential.
2. **`answerCallback` is awaited before any work** (`handleCallback` in `handlers.server.ts`). It adds a full Telegram RT to every button tap.
3. **`getUser` runs on every update** with `select("*")` and no cache.
4. **`listAssetNetworks` caches one entry per filter combination** (`catalogue:asset_networks:<symbol>:<dep>:<wd>`). Every new symbol is a cold DB join. `assetNetwork()` and cheque/invoice/transfer flows hit this.
5. **`listBalances` awaits balances, then prices, then catalogue sequentially.**
6. **`setSetting()` invalidates the whole `catalogue:` cache**, and it is called for every user's balance-view change and by the scan worker on every tick. The next bot request then re-runs the big catalogue join.
7. **Non-critical writes are awaited on the critical path**: `audit()`, `logEvent()`, `setSession()`, and admin notification messages.
8. **Wallet derivation is very slow for new users.** `deriveAddress()` calls `rootNode()` (mnemonic → PBKDF2 seed) on EVERY call, even for chains that return "pending", and `ensureAddresses()` runs it once per network row (EVM chains derive the same address 5 times) with one DB update per row.
9. **`ethers` is imported statically** in `wallet.server.ts`, which is imported by `db.server.ts`, so it loads on every cold start of the webhook.
10. **Bug that looks like "bot not replying":** the new-user welcome message is a PHOTO with a caption (`sendPhotoUrl` in `showMainMenu`). Every button on it calls `editMessage` (= `editMessageText`), which Telegram rejects for photo messages ("there is no text in the message to edit"). The error is only logged, so the tap does nothing.

### Required changes

**A1. Acknowledge callbacks immediately, in parallel.**
In `handleCallback`, start `answerCallback(query.id)` without awaiting it (`void ack.catch(() => {})`) and run the user lookup at the same time. A second `answerCallbackQuery` is ignored by Telegram, so for banned users send a normal message instead of a callback alert.

**A2. Overlap the idempotency claim with other work.**
In `webhook.ts` keep the `telegram_updates` claim, but start it together with the user lookup and the callback ack using `Promise.all`. If the claim reports a duplicate (`23505`), stop before any side effect. Everything that changes state must still happen after the claim resolved.

**A3. Cache the user row (short TTL).**
`getUser(telegramId)`: cache key `user:<telegram_id>`, TTL 15 s, single-flight via the existing `cached()` helper. Select only the columns in `XsUser` (no `*`). Call `cacheInvalidate("user:<id>")` in `registerUser`, in every admin action that changes `status` / `is_admin` (ban/unban commands in `admin.server.ts`), and whenever a user row is updated.

**A4. One catalogue cache entry, filtered in JS.**
Change `listAssetNetworks(filter)` to load the full enabled catalogue once under the single key `catalogue:asset_networks` (TTL `TTL.catalogue`) and apply `symbol`, `depositOnly`, `withdrawalOnly` filters in memory. `assetNetwork()` uses the same cached array.

**A5. Parallelise `listBalances`.**
Run the balances query, the prices cache read and the catalogue read in one `Promise.all`.

**A6. Stop nuking the catalogue cache.**
- `setSetting()` must invalidate only `settings:<key>`, not `catalogue:`. Call `cacheInvalidate("catalogue:")` only from the admin functions that really change assets/networks (`upsertAsset`, `setAssetEnabled`, `setAssetCommunityUrl`, `listTokenOnNetwork`; they already do).
- Move per-user `balance_view` out of `admin_settings`. Store it in `bot_sessions` (new nullable column `balance_view text`) or the `users` table via a small migration `0004`, read together with the user row. Update `getBalanceView` / `setBalanceView`.

**A7. Take non-critical work off the critical path.**
Add `src/lib/xstris/background.server.ts`:

```ts
// Runs a promise after the response is sent. Never throws.
export function background(task: Promise<unknown>): void {
  const safe = task.catch((e) =>
    console.error("[bg]", e instanceof Error ? e.message : "unknown"),
  );
  // Prefer the Worker's waitUntil so the runtime keeps the task alive.
  // Verify what the installed runtime supports (`cloudflare:workers` waitUntil,
  // or the `ctx` that src/server.ts already receives). If none is available,
  // the un-awaited promise above still runs. The Docker/bun build must keep working.
}
```

Use `background()` for: `audit(...)`, `logEvent(...)`, admin notification messages (new withdrawal request etc.), and the "Deposit received" message in `scan.ts`. Run `setSession(...)` in `Promise.all` with the `sendMessage/editMessage` that follows it instead of before it.

**A8. Fix wallet derivation cost.**
In `wallet.server.ts`:
- Compute `rootNode()` once per isolate and reuse it (module-level memo).
- Return `status: "pending"` for `bitcoin`, `ton`, `solana` BEFORE touching the mnemonic.
- Derive per family, not per network row (all EVM networks share one address for the same index).
- Load `ethers` with a dynamic `import("ethers")` inside the derivation function so it is not part of webhook cold start.
In `ensureAddresses()`: derive once per family, then write all rows with ONE upsert instead of N sequential updates.

**A9. Fix edits on photo messages (also needed for the QR screens).**
- Add `photo?: unknown[]` to `TgMessage` in `bot/types.ts`.
- Add `deleteMessage(chatId, messageId)` and `editKeyboard(chatId, messageId, keyboard)` (`editMessageReplyMarkup`) to `telegram.server.ts`.
- In `handleCallback`, the local `edit()` helper must check `query.message?.photo`. If the source message is a photo: `deleteMessage` it and `sendMessage` the new text (send first, delete in `background`). Otherwise `editMessage` as today.
- Welcome image: after the first successful `sendPhotoUrl`, store the returned photo `file_id` in `admin_settings` (`welcome_photo_file_id`) and reuse it, so first contact no longer depends on fetching a URL from the site.

**A10. Timing logs (so we can verify).**
In `webhook.ts` wrap handling with `performance.now()` and log one JSON line per update:
`{"perf":true,"kind":"callback|message","data":"<callback data prefix>","total_ms":123}`. Add a counter in `db.server.ts` for DB calls per update and include `db_calls`. No user data, no tokens, no addresses in logs.

**A11. Optional, only if warm callbacks are still slower than ~700 ms after A1-A10.**
One SQL function `xs_wallet_snapshot(_telegram_id bigint)` returning the user row plus balances in one RT, used by `wallet`, `menu` and `mainKeyboard`.

**A12. Trim cold start.**
Lazy-load `admin.server.ts` from `handlers.server.ts` (`await import(...)` only when the update is an admin command or `adm*` callback).

**Acceptance for A:** a menu, wallet or deposit tap does at most 1 sequential Supabase RT plus 1 Telegram RT before the reply is visible (when caches are warm). Tapping any button on the new-user welcome photo works.

---

## B. Deposit menu (`dep`)

Replace `openDepositAssets` and the deposit use of `tokenGroups`/`assetGrid` with a dedicated coin picker. Withdraw keeps its current layout (not requested).

**Buttons, in this fixed order and layout**

```
[ USDT ] [ USDC ]
[ BTC ] [ ETH ] [ BNB ]
[ TRX ] [ GRAM (TON) ] [ SOL ]
[ GRAM Token ] [ SOL Token ]
[ Back ]
```

- Top coins come from a constant `DEPOSIT_TOP = ["USDT","USDC","BTC","ETH","BNB","TRX","TON","SOL"]`. Show a coin only if it is enabled and has at least one `deposit_enabled` network.
- DB symbol stays `TON`. Add `coinLabel(symbol)` for buttons (`TON` → `GRAM (TON)`, others unchanged) and `coinText(symbol)` for messages (`TON` → `<b>GRAM</b>`, others `<b>SYMBOL</b>`). Do not rename the asset in the DB.
- REMOVE every other token-group button (no "BNB Smart Chain Tokens", "TRON Tokens", "Ethereum Tokens", "Solana Tokens" etc.) and remove pagination from this screen. Only "GRAM Token" and "SOL Token" remain as groups.
- Callback data (must stay under 64 bytes):
  - coin: `dep:a:<SYMBOL>`
  - network chosen: `dep:n:<SYMBOL>:<networkCode>` (add a trailing `:t` when opened from a token list, so Back returns to that list)
  - token lists: `dep:tk:ton` and `dep:tk:solana`

**Tapping a coin**
- More than one deposit network for that coin (USDT, USDC): show a chain picker. Text: `<b>Deposit — USDT</b>` then `Select the network:`. One button per network using `network_name` (for example "BNB Smart Chain (BEP20)"), then Back (`dep`). Put the deposit note (part H) under it.
- Exactly one network (BTC, ETH, BNB, TRX, GRAM, SOL): go straight to the address page. The network name is shown prominently on that page.

**GRAM Token / SOL Token**
- `dep:tk:ton` lists non-native assets on network `ton`; `dep:tk:solana` lists non-native assets on network `solana`. EXCLUDE USDT and USDC (they are already at the top). Grid of 3 per row, then Back (`dep`).
- Tapping a token goes to the address page for that token on that fixed network (no chain picker).
- Empty list: text `No tokens are listed on TON yet.` (or `Solana`) with Back.
- No other chain's tokens appear anywhere in the deposit flow.

Update `/deposit`, the wallet's Deposit button and the main menu button so all use this flow.

---

## C. Token catalogue for the two token lists

Current seed only has USDT/USDC on TON and Solana. Add migration `drizzle/migrations/0004_ton_and_sol_tokens.sql` that:
1. Inserts assets (if missing) for TON tokens `DOGS`, `TAKE`, `KETTON`, `NOT` and Solana tokens `TRUMP`, `GOOGLX`, `NVDAX`, using `INSERT ... ON CONFLICT (symbol) DO NOTHING`.
2. Lists each on its network with `xs_list_token(...)` ONLY if the exact contract address / mint and decimals are verified from an official source (Tonviewer / Solscan / the issuer). If you cannot verify one, do not include it in the migration and say so in your summary. Do not guess addresses.
3. Anything not seeded can be added by the admin via Admin Panel > Coin / token listing > List token on a network. The lists in part B render whatever is listed.

---

## D. "Pay via QR" flow

Replace the current `qrpay` handler (it currently sends a QR of a `https://t.me/<bot>?start=pay_<code>` link, which is wrong).

New flow: **coin → chain → QR image**.

1. `qrpay` shows the same coin picker as part B, using prefixes `qr:a:`, `qr:n:`, `qr:tk:` and Back → `menu`.
2. Chain picker and token lists behave exactly like part B (same helpers, different prefix).
3. On the final tap, send a PHOTO of a QR code whose payload is ONLY the raw deposit address for that user, coin and network. No `t.me` link, no URI scheme, no extra text in the QR.
4. Caption (must stay under 1024 characters, HTML):

```
<b>Payment via QR</b>
<b>USDT</b> — BNB Smart Chain (BEP20)

<code>{full address}</code>

Minimum deposit amount: 0.1 <b>USDT</b>

<blockquote>{deposit note from part H}</blockquote>
```

5. Attach a Back button to the photo message. Back deletes the photo and shows the QR coin picker (uses the photo handling from A9).
6. If the address is not available for that network (chain still "pending"), do not send a QR. Send a text screen: `This network is not activated yet, so no deposit address can be shown.` plus Back.
7. Reuse the same sender for the "Show QR code" button on the deposit page (`dep:qr:...`), so both produce the same caption, note and Back button (Back goes to that deposit page).
8. Cache generated PNGs in memory by address (small Map, max 200 entries) so repeat taps are instant.

Keep the `/start pay_...` deep-link handler as is so old QR codes do not break.

---

## E. Collapsed menu

- New `collapsedMenu()` in `keyboards.server.ts`:

```
[ Wallet ]
[ Deposit ] [ Withdraw ]
[ Exchange ] [ Swap ]
[ More ]
```

- `Exchange` and `Swap` use the same `soon()` / feature-flag logic as the full menu. `Wallet` uses the plain label `Wallet` (no balance lookup) so this menu opens instantly.
- The `collapse` callback: keep the message text and replace only the keyboard using `editKeyboard(...)` (no DB read). Remove the old "Menu collapsed. Send /start..." text.
- New callback `more`: restores the full main menu (text plus keyboard).
- The full main menu keeps its "Collapse menu" button. Remove its "Open app" row.

---

## F. Remove every website link from the bot

Remove all user-visible uses of `publicAppUrl()`:

- `keyboards.server.ts`: the "Open app" button.
- `messages.server.ts` `welcome()`: the "Read about all the features on the website" line. `about()`: the "Public dashboard" line.
- `handlers.server.ts`: the `Status page:` line in `set:support`, and the `Docs:` line in `apiText()`.
- Keep the welcome image working through the stored `file_id` from A9. The image URL is never shown to users.
- Delete unused `publicAppUrl` imports afterwards. Keep `publicAppUrl()` itself, the admin `/setwebhook` command needs it.

Do NOT remove Telegram links: cheque, invoice and referral deep links (`https://t.me/<bot>?start=...`) and per-coin community links (`assets.community_url`) are features, not website links.

---

## G. Branding: xStris Cheque

- `keyboards.server.ts` `chequeTypeMenu()`: rename the "Rocket-cheque" button to `xStris Cheque`, callback `soon:xstris_cheque`.
- `messages.server.ts` `chequeIntro()`: replace the "Rocket cheque" line with `· xStris Cheque — improved multi-cheque with distribution reward`.
- The `soon:` handler builds its title by capitalising words, which would produce "Xstris Cheque". Add an explicit label map (`SOON_LABELS = { xstris_cheque: "xStris Cheque", ... }`) and use it before falling back to the capitalising logic.
- Search the whole repo (`grep -ri rocket`) and rename every remaining hit. The brand is always written exactly `xStris` (never "Xstris", "XStris", "XSTRIS") in every user-facing string. Use `BRAND.name`.

---

## H. Deposit page, contract masking and notes

Rewrite `depositScreen()` in `messages.server.ts`. Target output:

```
<b>Deposit — USDT</b>

Wallet address for depositing <b>USDT</b> via BNB Smart Chain (BEP20) network:

<code>0x678BdB0858937430118ea6C03ee23091C17C4f71</code>

Minimum deposit amount: 0.1 <b>USDT</b>
Credited after 12 network confirmations.

Contract address: ...197955

<blockquote>Only send <b>USDT</b> via BNB Smart Chain (BEP20) network.
Any other coin, or any other network, results in permanent loss of funds.
Deposits below the minimum amount are not credited.
Before sending, check that the token contract ends with ...197955.
Do not send from BNB Beacon Chain (BEP2), opBNB or any other network.</blockquote>
```

Rules:
- The user's WALLET address is always shown in full (it must be copyable).
- Only the CONTRACT address is shortened, and it is NOT in `<code>`: `contractTail(addr, 6)` returns `...` + last 6 characters. Never render a full contract address anywhere in the bot (deposit, QR caption, withdraw, limits).
- All notes live inside one `<blockquote>`, built by a single helper `depositNote(row)` so every deposit screen stays identical. Use it on: coin/chain picker, address page, QR caption, and the "not activated yet" screen.
- The note is built from: coin (bold), network name, the generic lines above, the contract-tail line only when `contract_address` exists, plus a per-network line from a `NETWORK_WARNING` map keyed by `network_code`:
  - `bsc`: "Do not send from BNB Beacon Chain (BEP2), opBNB or any other network."
  - `tron`: "Only TRON (TRC20). Do not send from any other network."
  - `eth`: "Only Ethereum mainnet (ERC20). Layer-2 networks are separate networks."
  - `bitcoin`: "Bitcoin network only. Do not send wrapped BTC such as BTCB or WBTC."
  - `ton`: "TON network only. Do not send from any other network."
  - `solana`: "Solana network only. Send only tokens that use Solana."
  - `polygon`, `base`, `arbitrum`: "Only send via this exact network. Other EVM networks are different networks."
- Do not use any emoji in notes (see part J).
- Store note text as constants so the copy is edited in one place.

---

## I. Bold coin names

Add `coinText(symbol)` (part B) and use it for every coin symbol or coin name shown in message text, captions and edited screens, including: wallet balances (`<a href><b>SYM</b></a>: amount <b>SYM</b>` where the community link exists), deposit, withdraw (all prompts, confirm screen, admin notification), cheque and invoice creation/claim/pay messages, transfers ("Sent 1.5 <b>USDT</b> to @x"), history lines, limits and fees, admin balances/deposits/withdrawals/assets/listing screens, and the scan worker's "Deposit received" message.

Do not put `<b>` inside `<code>` blocks. Inline-button text stays plain.

---

## J. Emoji rules

Only two emoji exist in the bot: ✅ and ❌. Nothing else, anywhere (no ⚠️, no arrows or decoration emoji).

Use ✅ for confirm / accept / approve / paid / credited:
- Buttons: `✅ Confirm withdrawal`, `✅ Pay` (invoice), admin `✅ Send <SYMBOL>` (approve).
- Messages: `✅ Invoice paid: ...`, `✅ Your invoice was paid: ...`, `✅ Withdrawal approved and queued for payout.`, `✅ Your <SYMBOL> withdrawal was approved and is being sent.`, `✅ Deposit received: ...`, `✅ Credited ...` / `✅ Your balance was credited ...` (admin manual credit).

Use ❌ for reject / cancel:
- Buttons: `❌ Cancel` (withdraw confirm, invoice pay), admin `❌ Reject`.
- Messages: `❌ Cancelled.` (user flow and admin flow), `❌ Withdrawal rejected and funds returned.`, `❌ Your <SYMBOL> withdrawal was rejected. The funds are back in your balance.`

Status words in lists (history, invoices, cheques, admin deposits/withdrawals): add one helper `statusLabel(status)` in `messages.server.ts` and use it everywhere a status is printed. `paid`, `confirmed`, `approved`, `accepted`, `completed` → `✅ <status>`. `rejected`, `cancelled`, `canceled` → `❌ <status>`. Every other status stays plain text.

Errors ("Not enough balance", "could not be created", "failed") get no emoji.

---

## Tests and verification (add to `src/lib/xstris/__tests__/`)

1. `keyboards.test.ts`: the deposit picker has exactly the top coins that exist, in the order and rows of part B, plus `GRAM Token` and `SOL Token`, plus Back, and contains no button whose label ends in "Tokens".
2. `messages.test.ts`: `contractTail("0x55d398326f99059fF775485246999027B3197955")` returns `...197955`; `depositScreen()` output never contains a full contract address, contains one `<blockquote>`, and contains the full wallet address; `coinText("TON")` returns `<b>GRAM</b>`.
3. `collapsedMenu()` has exactly these labels: Wallet, Deposit, Withdraw, Exchange, Swap, More.
4. Repo greps that must return nothing in bot code: `Open app`, `Rocket`, `Status page`, `Docs:`, `Public dashboard`, `Read about all the features`.
5. A grep for emoji characters across `src/lib/xstris` and `src/routes` may only match ✅ and ❌.
6. Manual checks: `/start` as a brand-new user then tap every button on the welcome photo; Deposit → USDT → BNB → address page → Show QR → Back; Pay via QR → SOL Token; Collapse menu → More.

## Final summary to return

List what changed per part (A to J), the before/after timing logs from A10 for `menu`, `wallet` and `dep`, and any token from part C that could not be verified.
