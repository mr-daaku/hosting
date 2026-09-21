# xStris prompt 5: bug fixes, withdraw redesign, safe listing, deposit verification, security, fresh start

Read the whole file first. Implement Parts 1 to 9 in order, keep the branch buildable after each part, and run `bunx vitest run` at the end. Part 10 (Solana / TON / Bitcoin) is done only after Parts 1 to 9 work in Telegram.

## 0. Ground rules

- Keep everything prompts 1 to 4 built (deposit picker, QR flow, collapsed menu, branding, bold coins, blockquote notes, no website links). Only change what this file says.
- Emoji rule stays: only ✅ (confirm / accept / approve / paid / credited) and ❌ (cancel / reject). No other emoji anywhere. In verification reports use the words `Match` / `MISMATCH` instead of icons.
- Coin names in message text are bold. Deposit and withdraw screens carry a `<blockquote>` note. Inline-button labels stay plain text.
- Never invent a contract address, API response field or endpoint. Verify each external API once with a real call before coding against it. If a call cannot be made from your environment, code defensively (optional fields, timeouts) and tell me in the final summary.
- NEVER ask me for, print, log or store the wallet mnemonic or any private key. All key handling in this file is designed so the running app never needs them.
- Do not touch `xs_credit_deposit`, `xs_internal_transfer`, `xs_create_cheque`, `xs_claim_cheque`, RLS on existing tables, or the website routes.
- New tables and functions follow the existing pattern: RLS enabled, `GRANT ALL ... TO service_role` only, functions `REVOKE ALL ... FROM PUBLIC, anon, authenticated`.

---

## 1. Critical bugs found in the current code

### 1.1 New user: first /start gets no reply, second /start shows "not activated", no address ever

Evidence in the code, in order of certainty:

1. **Addresses are never saved.** `ensureAddresses()` in `db.server.ts` writes with `.upsert(updates, { onConflict: "id" })` where every object has only `id, address, derivation_path, status`. Postgres checks NOT NULL on the proposed INSERT row before it looks at the conflict, so `user_id` and `network_id` (both NOT NULL) reject the whole statement. The returned `error` is never checked, so it fails silently and every user keeps `address = null`.
2. **Never retried.** `ensureAddresses()` only runs inside `registerUser()`. A user whose derivation failed keeps NULL addresses forever, and `getAddress()` just returns null, which produces "This network is not activated yet".
3. **Heavy work inside the very first request.** Registration currently waits for: dynamic `import("ethers")`, mnemonic to seed (PBKDF2, pure JS), key derivation, and DB writes, all before the welcome message is sent. If the Worker hits its CPU or time limit the request dies with no reply. Telegram then retries, but `webhook.ts` already recorded that `update_id`, so the retry is dropped as a duplicate. The user row exists (created by `xs_register_user`), so the second /start works but shows a menu whose addresses are empty. This matches the symptom exactly.
4. **Errors are invisible to the user.** In `webhook.ts` any exception is swallowed: the user gets nothing, and `logEvent` stores only `update_id` (no error message).

To confirm before changing code, run in the SQL editor:

```sql
select count(*) filter (where address is null) as null_addresses, count(*) as total from wallet_addresses;
select created_at, message, details from system_events where scope = 'telegram.webhook' order by created_at desc limit 20;

-- expected to fail with: null value in column "user_id" ... violates not-null constraint
begin;
insert into wallet_addresses (id, address)
  select id, 'test' from wallet_addresses limit 1
  on conflict (id) do update set address = excluded.address;
rollback;
```

### 1.2 "Show QR code" sends nothing

`qr.server.ts` uses `QRCode.toBuffer(...)` from the `qrcode` package. That method exists only in the Node build. In a Worker bundle the package resolves to its browser build, which has no `toBuffer`, so the call throws, `renderQrPng` returns null, and the user sees no image. Also `sendPhotoBuffer` only logs `res.status` (never Telegram's description) and returns null with no fallback to the user.

---

## 2. Fix the new-user flow and addresses

**2.1 Registration must be instant.** `registerUser()` = the `xs_register_user` RPC only. No derivation, no `ensureAddresses`, no `ethers` import in this path. `/start` replies as soon as the user row exists.

**2.2 Lazy, checked address creation.** Add `getOrCreateAddress(user, networkCode)` in `db.server.ts`:
1. read the `wallet_addresses` row (one query, joined with `networks`);
2. if `address` is null and the network's family is derivable, derive it (see 2.3) and save it with a plain `UPDATE ... WHERE id = <row id>` (never an upsert with partial columns);
3. CHECK the returned `error`; on failure throw, log to `system_events` with the message, and show the user a normal error screen, never silence;
4. return `{ address, status }`.
Use it in `showDeposit`, `sendQrScreen` and anywhere an address is needed. Remove the derive-at-registration loop.

**2.3 Derive without the mnemonic (fast and safer).** The app must never hold the mnemonic. It derives deposit addresses from a public extended key:
- New env secret `XSTRIS_EVM_XPUB` = the extended public key at path `m/44'/60'/0'/0`.
- Address for user index `i`: `HDNodeWallet.fromExtendedKey(xpub).deriveChild(i).address` (non-hardened, about a few ms, no PBKDF2). Verify the exact ethers 6.17 API (`fromExtendedKey`, `deriveChild`, void-wallet address getter) with a small unit test against a known xpub.
- EVM networks (bsc, eth, polygon, base, arbitrum) all use that address.
- TRON uses the SAME key: address = Base58Check of `0x41 + <20-byte EVM address>` (reuse the existing checksum/base58 code). Fresh start (Part 9) lets us use this scheme without migrating old addresses.
- Remove `XSTRIS_MASTER_MNEMONIC` from `config.server.ts`, `.env.example` and README. If `XSTRIS_EVM_XPUB` is missing, `getOrCreateAddress` returns `{ address: null, reason: "XPUB_MISSING" }` and the admin gets a one-time Telegram alert.
- Add `scripts/print-xpub.mjs` for ME to run once on my own computer, offline:

```js
// Run locally and offline. Never paste the mnemonic anywhere else.
import { HDNodeWallet, Mnemonic } from "ethers";
import { createInterface } from "node:readline/promises";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const phrase = await rl.question("Mnemonic: ");
rl.close();
const account = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim()), "m/44'/60'/0'/0");
console.log("XSTRIS_EVM_XPUB=" + account.neuter().extendedKey);
```

- Add an admin command `/repair_addresses` that fills every NULL address for existing users with `getOrCreateAddress` and reports counts.

**2.4 Honest "not live" state.** Add `networks.deposits_live boolean not null default false` (migration 0005). Set it true only for `bsc, eth, tron, polygon, base, arbitrum` after Part 6 works. For a network that is not live, the deposit page and QR flow show only:

```
<b>Deposit — GRAM</b>

Deposits via TON are opening soon.
```
plus Back. Remove the old texts "This network is not activated yet..." and "Support for this chain is being finished." Hide non-live networks from chain pickers. If a coin has no live network, tapping it shows the same "opening soon" screen.

**2.5 Webhook reliability (`webhook.ts`).**
- On any handler exception: log the error message (truncated to 300 chars, no addresses/tokens) into `system_events`, `background()` a short reply to the user (`Something went wrong. Please try again.`), and DELETE the claimed `telegram_updates` row so a retry is not silently dropped. Still return 200.
- Body limit: reject requests over 64 KB (check `content-length` and actual length) with 413.
- Only handle updates from private chats (`message.chat.type === "private"` or a callback whose message chat is private). Ignore everything else silently.

---

## 3. Fix QR generation

Replace `QRCode.toBuffer`. Keep `qrcode` only for the matrix: `QRCode.create(text, { errorCorrectionLevel: "M" }).modules` gives `{ size, data }`. If the resolved browser build does not export `create`, switch the dependency to `uqr` (`encode(text)` returns a boolean matrix) and adapt the accessor. Then write the PNG with the pure encoder below. Add it exactly as `src/lib/xstris/qr-png.ts`. It uses no Node APIs. I tested this exact encoder by generating PNGs for EVM, TRON, Solana and TON-style addresses and decoding them back with an independent QR reader: all four decoded to the exact original string.

```ts
export interface QrModules {
  size: number;                              // modules per side
  data: ArrayLike<number | boolean>;         // row-major, truthy = dark
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  return concat([new Uint8Array(u32(data.length)), body, new Uint8Array(u32(crc32(body)))]);
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let pos = 0; ; pos += 65535) {
    const slice = raw.subarray(pos, Math.min(pos + 65535, raw.length));
    const last = pos + 65535 >= raw.length;
    const len = slice.length;
    parts.push(new Uint8Array([last ? 1 : 0, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255]), slice);
    if (last) break;
  }
  parts.push(new Uint8Array(u32(adler32(raw))));
  return concat(parts);
}

export function qrMatrixToPng(modules: QrModules, target = 512, margin = 4): Uint8Array {
  const n = modules.size;
  const total = n + margin * 2;
  const scale = Math.max(1, Math.ceil(target / total));
  const px = total * scale;
  const rowBytes = Math.ceil(px / 8);
  const raw = new Uint8Array((rowBytes + 1) * px);      // filter byte 0 per row; bit 1 = white
  for (let y = 0; y < px; y++) {
    const my = Math.floor(y / scale) - margin;
    const rowStart = y * (rowBytes + 1);
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark = my >= 0 && my < n && mx >= 0 && mx < n && Boolean(modules.data[my * n + mx]);
      if (!dark) raw[rowStart + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const ihdr = new Uint8Array([...u32(px), ...u32(px), 1, 0, 0, 0, 0]);   // 1-bit grayscale
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
```

In `qr.server.ts`: `renderQrPng(payload)` = `create` → `qrMatrixToPng`, keep the small in-memory cache, and remove the duplicate `qrCache` in `handlers.server.ts` (one cache only). In `telegram.server.ts` make `sendPhotoBuffer` read Telegram's JSON body and log `description` on failure. In `sendQrScreen`, if the photo send fails, fall back to a text screen with the address in `<code>`, the note, and Back. The user must never get silence.

Add a vitest: encode a known matrix, assert PNG signature bytes, the IHDR size, and that the IEND chunk is last.

---

## 4. Withdraw redesign: coin, then chain, only what the user owns

Replace the current Withdraw picker (all symbols + token groups + pages) with this flow.

**4.1 `wd` — coin list from holdings.**
- Show only coins where the user's `available > 0` AND the coin has at least one `withdrawal_enabled` network. Sorted by asset `sort_order`, 3 per row, 9 per page with numbered pagination if needed, then Back to `menu`. Button label uses `coinLabel()` (TON shows as `GRAM (TON)`).
- Text:

```
<b>Withdraw</b>

Your balances:
<b>USDT</b>: 12.5
<b>BNB</b>: 0.02

Select the coin you want to withdraw:
```
- No holdings: `You have no funds to withdraw yet.` plus Back. No token groups, no coins the user does not own.

**4.2 `wd:a:<SYMBOL>` — chain picker.**
- One button per `withdrawal_enabled` network for that coin, labelled `<network name> · fee <fee> <SYMBOL>`. If there is only one network, skip the picker.
- Text ends with a blockquote note: `Choose the network your receiving wallet or exchange supports. Funds sent to the wrong network are lost permanently.`

**4.3 `wd:n:<SYMBOL>:<network>` — fee gate.** Read the row live (not from a stale cache). Let `need = max(min_withdrawal, withdrawal_fee + 1 base unit)`.
- If `available < need`, do NOT continue and do NOT start a session. Show:

```
<b>Withdraw — USDT</b>

Network: BNB Smart Chain (BEP20)
Balance: 1 <b>USDT</b>
Withdraw fee: 1.5 <b>USDT</b>
Minimum withdrawal: 5 <b>USDT</b>

<blockquote>Your balance does not cover the withdraw fee and minimum. You need at least 5 <b>USDT</b> to withdraw via this network.</blockquote>
```
  with Back to the chain picker (the user may pick a cheaper network).
- Otherwise create a session `wd_address` with a fresh random `nonce` and ask for the address, with the note in a blockquote: `Send only to a <network name> address that supports <SYMBOL>. A wrong network or wrong address cannot be recovered.`

**4.4 Address validation.** Besides `validateAddress(family, ...)`, reject and explain when the address:
- equals any address in `wallet_addresses` (own or another user's xStris deposit address; tell the user to use Transfer between balances);
- equals any listed `contract_address` (a token contract is not a wallet);
- is a burn/zero address (`0x000...0`, `0x...dEaD`).

**4.5 Amount and confirm.** Enforce `amount >= min_withdrawal`, `amount > fee`, `amount <= available`. The confirm screen shows amount, fee, `You will receive: amount minus fee`, network, address in `<code>`, buttons `✅ Confirm withdrawal` (callback `wd:cf:<nonce>`) and `❌ Cancel`. The fee stays deducted from the amount (as `xs_create_withdrawal` already does).

**4.6 Atomic and DB-enforced submit.** New migration function `xs_request_withdrawal(_user_id, _asset_id, _network_id, _to_address, _amount, _expected_fee, _idempotency_key)`:
- loads the `asset_networks` row itself (`FOR SHARE`) and raises `WITHDRAWAL_DISABLED`, `BELOW_MIN`, `AMOUNT_BELOW_FEE`, `FEE_CHANGED` (when `_expected_fee` differs from the row's current fee), `DAILY_LIMIT` (use the existing `daily_limit` column: sum of the user's withdrawals for that asset in the last 24 h), `TOO_MANY_PENDING` (max 3 pending per user);
- then does what `xs_create_withdrawal` does (reserve funds, ledger rows) using the DB fee, never a caller-supplied fee;
- `idempotency_key = 'wd:' || user_id || ':' || nonce`, so a double tap or concurrent taps create at most one withdrawal.
In `submitWithdrawal`, consume the session atomically (`delete from bot_sessions where telegram_id = $1 and state = 'wd_confirm' and payload->>'nonce' = $2 returning payload`); if nothing is returned, reply `This request expired.` On `FEE_CHANGED`, re-show the confirm screen with the new fee. The admin notification is sent with `background()`.

---

## 5. Withdraw fee for every coin, editable by the admin

- Every `asset_networks` row must have a fee (native coins, tokens, stablecoins). Migration 0005: for rows where `withdrawal_fee = 0` set a sensible non-zero default per network family and list every changed row in the summary so I can review the numbers.
- Replace the read-only "Fees & Limits" screen with an editor:
  1. `adm:fees` shows a coin grid. 2. Tapping a coin lists its networks. 3. Tapping a network shows current values (withdraw fee, min withdrawal, min deposit, confirmations, deposits on/off, withdrawals on/off) with one button per field. 4. Tapping a field asks for the new value in coin units (for example `1.5`), parsed with the row's decimals. 5. A preview `old → new` with `✅ Confirm` / `❌ Cancel`.
- Rules: `fee >= 0`, `min_withdrawal > fee` (otherwise nobody could withdraw), amounts capped at 40 characters. Save through a small RPC `xs_admin_set_fee` (also writes an `audit_logs` row with old and new values), then `cacheInvalidate("catalogue:")`.
- Shortcut command: `/setfee SYMBOL network amount`, same validation and confirm step.
- Because caches are per Worker instance, the withdraw path must read the live row (4.3) and the DB function re-checks the fee (4.6), so a fee change takes effect immediately everywhere. Lower `TTL.catalogue` to 30 s.

---

## 6. Deposit verification (scanner rewrite)

Bugs in `scan.ts` that can lose or wrongly credit money:
1. `setSetting(stateKey, { last_block: toBlock })` runs even when `evmLogs` returned `null` (RPC failure), so those blocks are skipped forever.
2. `toBlock` = chain head, so deposits are credited with zero confirmations (reorg risk). `_confirmations` is passed `log.blockNumber`, which is a block number, not a confirmation count.
3. `fromBlock = max(last+1, head-5000)` silently skips deposits after any outage longer than 5000 blocks.
4. Deposits below `min_deposit` are dropped with `continue` and never recorded.
5. `log.removed` is not checked.
6. One `eth_getLogs` call with every user address as a topic will exceed RPC limits as users grow.
7. Native coins (ETH, BNB, TRX) and TRC20 are never scanned. Only ERC20/BEP20 logs are.
8. `background(sendMessage(...))` for "Deposit received" can be dropped (see Part 7.1).

Required rewrite (same endpoint, same secret, still idempotent through `xs_credit_deposit`):
- **Cursor table** `scan_cursors(network_id primary key, last_block bigint, updated_at)` instead of `admin_settings`. Missing cursor initialises to `head - confirmations`. The cursor advances only after EVERY RPC call in that range succeeded and every found deposit was processed.
- **Depth:** scan up to `head - confirmations` (per `asset_networks.confirmations`). Catch up in chunks of at most 2000 blocks, several chunks per run, with a 20 s time budget per run. No 5000-block cap.
- **Recipient filter in batches:** for token logs, query with the listed contract as `address` and recipient topics in batches of 100 addresses. Match recipients in memory against the owners map.
- **Native coins (EVM):** scan blocks with full transactions in JSON-RPC batches and match `tx.to` against owners with `value > 0` and receipt `status = 0x1`. **TRON:** scan blocks with the TronGrid block/transaction-info endpoints for `TransferContract` (TRX) and TRC20 `Transfer` logs of listed contracts. Verify each endpoint's response shape first.
- **Verification rules, all must hold before crediting:**
  1. The log's emitting contract equals the listed contract for that network (normalised compare). Any other contract with the same symbol or name is ignored.
  2. Recipient equals a deposit address stored for a user on that network.
  3. `removed` is not true; transaction receipt status is success.
  4. Confirmations at credit time are at least the configured number; re-fetch the block and confirm its hash equals the hash seen when first detected (reorg check).
  5. Amount is at least `min_deposit`.
  6. Decimals used for the amount come from the listed row (which the listing wizard verified on-chain).
- Anything that matches an address but fails a rule goes to a new table `unmatched_deposits(network_id, tx_hash, log_index, address, contract, amount, reason, created_at)` with reasons `below_min`, `contract_mismatch`, `not_enough_confirmations_timeout`. Add an admin screen "Unmatched deposits". Nothing is dropped silently.
- Store `block_hash` and a small `verification jsonb` (contract matched, confirmations at credit) on the `deposits` row (columns added in migration 0005).
- The "Deposit received" message is `✅ Deposit received: <amount> <b>SYMBOL</b> on <network>.` and is sent inside the request (awaited, or via a working `waitUntil`).
- Fake or duplicate coins cannot be credited: only listed contracts are watched, and listing enforces unique contracts (Part 8).
- Constant-time compare for the worker secret. Scheduling: set up a call every minute (pg_cron + pg_net, or an external cron). If the platform cannot, say so in the summary. Alert the admin if any cursor has not advanced for 10 minutes.
- After this works, set `networks.deposits_live = true` for `bsc, eth, tron, polygon, base, arbitrum`.

---

## 7. Speed: what is still slow

Measured data first. `webhook.ts` already logs `{"perf":true,...,"total_ms","db_calls"}`. Extend it with `tg_ms` (time spent in Telegram calls) and `db_ms`, and make `db_calls` per request (see 7.5). Read the last 50 lines for `menu`, `wallet`, `dep`, `wd` and put p50 and max in the final summary. Rule of thumb for the report: if `db_calls <= 3` and `total_ms` is still above about 800, the delay is network distance (Supabase region vs Worker location), not code.

Code causes still present:

**7.1 `background()` is not wired to the runtime.** `registerWaitUntil` is defined but never called, so `auditBg`, `logEventBg`, the welcome-photo `file_id` save, admin notifications and "Deposit received" messages can be cancelled when the response is returned. Fix with a per-request context: in `src/server.ts` wrap `handler.fetch(request, env, ctx)` in an `AsyncLocalStorage` (or use `waitUntil` from `cloudflare:workers` if the installed runtime provides it) and make `background()` call that request's `waitUntil`. Do not keep one global. The Docker/bun build must keep working: without a `waitUntil`, run the promise un-awaited. Anything money-related or user-facing that must not be lost (deposit notifications) is awaited instead.

**7.2 The update claim is still serial.** In `webhook.ts` the `telegram_updates` insert is awaited before anything else. Start the claim, the user lookup and the callback ack together with `Promise.all`; if the claim reports a duplicate (`23505`), stop before any side effect.

**7.3 Serial steps on hot paths.**
- `/start`: `await setSession(...)` runs before the menu is built. Run it in parallel with `mainKeyboard`.
- `mainKeyboard`: `await features()` runs after `listBalances`. Put both in one `Promise.all`.
- `sendQrScreen`: `assetNetwork` then `getAddress`. Run them together (the catalogue read is cached).
- `submitWithdrawal`: the admin notification is awaited. Make it `background()`.
- `showMainMenu` for new users: `getSetting("welcome_photo_file_id")` runs after the keyboard. Fetch it in the same `Promise.all`.

**7.4 New-user cost** disappears with Part 2 (no derivation on the request path).

**7.5 The metrics counter is global.** `dbCalls` in `db.server.ts` is module-level, so concurrent requests mix their counts. Store the counters in the same per-request `AsyncLocalStorage` as 7.1.

**7.6 Keep warm.** Add a cheap scheduled `GET /api/public/telegram/webhook` every minute (the route already answers). It keeps an instance and its caches alive.

**7.7 Only if p50 is still above about 700 ms after the above:** add one SQL function `xs_wallet_snapshot(_telegram_id bigint)` returning user row plus balances in one round trip, and use it for `menu`, `wallet` and `wd`.

**7.8 Region check (owner action, no code).** In the summary tell me to compare the Supabase project region with the region the Worker runs in, and whether Cloudflare Smart Placement can be enabled for this deployment. I will report back.

---

## 8. Admin: safe step-by-step coin / token listing

Replace the free-text "List token on a network" (`SYMBOL | network | contract | ...`) and the separate "Add new coin" with one guided wizard. Keep community link, enable/disable and applications screens.

**Flow** (state kept in `bot_sessions.payload`, one message edited per step, expires after 30 minutes, every step has Back and `❌ Cancel`):

1. **Chain:** buttons for enabled networks (`adm:ls:c:<code>`).
2. **Symbol:** text. Uppercased, must match `^[A-Z0-9]{2,12}$` (ASCII only, so look-alike Unicode letters are rejected). If the symbol already exists, show its current name and networks and ask whether this is the same asset on another chain (only then continue). If the same symbol is already listed on this chain, stop.
3. **Full name:** 2 to 40 characters, letters, digits, space and `.-'&` only, no links.
4. **Contract address:** REQUIRED. Validate the format for the chain family (EVM: `0x` + 40 hex and EIP-55 checksum when mixed case; TRON: Base58Check `T...`; TON: friendly address with CRC check; Solana: Base58 that decodes to 32 bytes). A "native coin" button is offered ONLY when the symbol equals that network's native symbol (add `networks.native_symbol`: bsc BNB, eth ETH, tron TRX, ton TON, solana SOL, bitcoin BTC, polygon POL, base ETH, arbitrum ETH). Refuse if `(network, contract)` is already listed and tell me which symbol owns it.
5. **Automatic verification report** posted as the bot's reply (details below).
6. Buttons: `✅ Confirm listing`, `Edit contract`, `❌ Cancel`.
7. **Fees and limits (required):** ask `withdraw fee | min withdrawal | min deposit` in coin units in one message, with the numbers validated as in Part 5, then a final preview with `✅ List now` / `❌ Cancel`.
8. On confirm, one RPC `xs_list_token_v2` creates the asset if needed and the `asset_networks` row (decimals taken from the verification, not typed by the admin), stores `verification jsonb`, `listed_by`, `listed_at`, sets `deposit_enabled` and `withdrawal_enabled` true, writes an audit row, invalidates caches, and the admin gets `✅ <b>SYMBOL</b> is listed on <network>.`

**Verification report** (all values escaped, all external strings treated as untrusted):
- On-chain: contract exists and is a token; on-chain name, symbol, decimals and total supply, each shown next to what the admin typed with `Match` or `MISMATCH`. EVM and TRON: `eth_call` / `triggerconstantcontract` for `name()` `0x06fdde03`, `symbol()` `0x95d89b41`, `decimals()` `0x313ce567`, `totalSupply()` `0x18160ddd` plus a non-empty code check. Solana: `getAccountInfo` (jsonParsed) for decimals, supply, mint authority and freeze authority; the owning program must be the SPL Token or Token-2022 program. TON: the jetton master data from TonAPI including its `verification` field (block the listing if it is `blacklist`).
- Market: price in USD, 24 h volume, liquidity, market cap or FDV, number of pools, age of the oldest pool. Use GeckoTerminal (`/api/v2/networks/{network}/tokens/{address}`; list `/api/v2/networks` first to get the exact network ids for eth, bsc, tron, solana, ton, polygon, base, arbitrum) and fall back to DexScreener. Show the source name and time. If nothing is found print `No market data found.`
- Blocking rules: symbol or decimals `MISMATCH` blocks `✅ Confirm listing`. Name mismatch, no market data, or liquidity under a configurable minimum (admin setting `min_listing_liquidity_usd`, default 10000) do not block, but require the admin to type `LIST <SYMBOL>` first.
- All fetches: 5 second timeout, HTTPS only, response size cap, zod-validated, at most one verification per admin per 3 seconds.

**Database rules (migration 0005):**
- Unique index on `asset_networks (network_id, contract_address) where contract_address is not null`.
- `check (is_native = (contract_address is null))`, and the native listing is allowed only when the symbol equals `networks.native_symbol` (enforced in `xs_list_token_v2`).
- The existing `xs_list_token` currently overwrites a contract on conflict. Replace it so a different contract for an existing `(asset, network)` raises `CONTRACT_CHANGE_FORBIDDEN`. To change a token's contract the admin must disable it and list a new symbol.
- Add admin command `/verify_listings` that runs the same on-chain check against every currently listed contract (including the seeded ones from migrations 0003 and 0004) and returns a report. Any listing that fails gets `deposit_enabled = false` and `withdrawal_enabled = false` until the admin re-enables it.

---

## 9. Security hardening

**9.1 Rate limiting and flood control**
- In-instance token bucket per Telegram user (no DB call): 8 updates per 10 seconds. Over the limit: drop silently, no Telegram call. Five trips in 10 minutes: block that user for 15 minutes (`blocked_users` table, cached), and alert the admin once.
- DB limiter `xs_rate_limit(_key text, _limit int, _window_seconds int) returns boolean` (atomic upsert counter in `rate_limits`, old rows purged). Use it for: new registrations (global cap 60 per minute, admin alert when hit), withdrawal requests (3 per hour per user), internal transfers (20 per hour), cheque claims and cheque code lookups (10 per minute per user), invoice creation, listing verification, Pay API (60 requests per minute per API key, and 10 failed authentications per minute per IP).
- Limits are constants in one file so I can tune them.

**9.2 Webhook and worker authentication**
- Constant-time comparison for `x-telegram-bot-api-secret-token` and for the worker secret. If `TELEGRAM_WEBHOOK_SECRET` is missing or shorter than 32 characters, refuse all webhook requests (fail closed).
- Validate every update shape (types, lengths). `callback_data` and text inputs are length-capped (500 characters for our own inputs).

**9.3 Admin fail closed**
- Remove the hard-coded default admin id in `config.server.ts`. If `TELEGRAM_ADMIN_ID` is not set, nobody is admin.
- Stop trusting `users.is_admin` in `handlers.server.ts` (`isAdmin`). Admin is only `telegram_id === TELEGRAM_ADMIN_ID`.
- Every money-affecting admin action (approve or reject withdrawal, manual credit, fee change, listing) needs an explicit `✅ Confirm` step and writes an audit row. Send the admin an alert for: fee changes, new listings, flood blocks, scanner stuck, failed authentications spike.

**9.4 Money paths**
- Withdrawal: Part 4.6 (nonce, atomic session, DB-enforced limits, max 3 pending).
- Cheque codes: `createCheque` uses `Math.random`, which is predictable. Generate at least 16 characters from `crypto.getRandomValues` (base32, no ambiguous characters).
- Transfers by username: `performTransfer` uses `ilike("username", handle)`, where `_` and `%` act as wildcards and usernames can be reassigned. Use an exact case-insensitive match (`lower(username) = lower($1)`, indexed), and add a confirm screen `Send 5 <b>USDT</b> to @name? ✅ Confirm / ❌ Cancel` bound to a nonce before executing.
- `parseAmount` inputs are capped at 40 characters and must be positive.

**9.5 Pay API**
- Never return raw database error messages: respond with a generic message plus a short request id, and log the details.
- Body limit 10 KB, `content-type: application/json` required, list endpoints capped, `Idempotency-Key` header supported on invoice creation.
- Rate limits from 9.1.

**9.6 Logging and data hygiene**
- Never log deposit addresses, withdrawal addresses, tokens, full updates or API keys.
- New `security_events` table for rate-limit trips, auth failures, blocked users, admin actions. Admin screen "Security log" with the last 30 events.
- Confirm RLS is enabled on every table and every new function is revoked from `anon` and `authenticated`. Report anything that is not.

**9.7 Secrets**
- The mnemonic no longer exists in the app (2.3). Add a README section listing the required secrets and stating that the mnemonic must be kept offline. Confirm `.env` is git-ignored and that the service role key is never placed in a `VITE_*` variable.

---

## 10. Solana, TON, Bitcoin (only after Parts 1 to 9 pass)

Their keys are hardened (ed25519 for Solana and TON), so an xpub cannot be used. Design:
- Offline script `scripts/generate-address-pool.mjs` that I run on my own computer, reading the mnemonic locally, and outputs a CSV of PUBLIC addresses only (`family, index, address`) for a range I choose (for example 5000 per family). Solana: SLIP-0010 ed25519 path `m/44'/501'/i'/0'`. TON: standard wallet address for the ed25519 key at `m/44'/607'/i'`. Bitcoin: native SegWit from an account xpub (so it can also use the xpub approach). Never ask me for the mnemonic.
- Table `address_pool(family, idx, address unique, assigned_user_id null)` filled from the CSV through an admin-only import; `getOrCreateAddress` assigns the next free row atomically (`for update skip locked`). Alert the admin when fewer than 200 free addresses remain per family.
- Deposit detection per family, with the same verification rules as Part 6: Solana (listed mint, recipient token account owner, finalized commitment), TON (jetton transfer notifications by owner, plus native TON), Bitcoin (confirmations via a public API such as mempool.space). Poll only addresses that opened the deposit page in the last 60 minutes every minute, plus a slower sweep of all addresses, to keep cost bounded.
- Set `deposits_live = true` for a chain only after its scanner has been tested with a real small deposit. Until then these chains keep the "opening soon" screen from 2.4. If this part is too large for one pass, stop after the address pool and report.

---

## 11. Fresh start: delete all existing data

I confirm this is a test environment and I want a clean start. Create `drizzle/manual/fresh_start.sql` (NOT inside `drizzle/migrations`, so it never re-runs). Run it once now. It must keep `networks`, `assets`, `asset_networks`, `rpc_providers`, `prices`, and these `admin_settings` keys: `features`, `maintenance`, `community_url`, `referral_reward`, `price_provider`, `welcome_photo_file_id`. It must NOT reset `wallet_index_seq` (old on-chain addresses must never be handed to a new user).

```sql
do $$
declare
  confirmed constant boolean := false;  -- set to true only for the one approved run, then set back to false
  t text;
begin
  if not confirmed then
    raise exception 'Fresh start not confirmed: edit confirmed to true for this one run.';
  end if;
  foreach t in array array[
    'ledger_entries','blockchain_transactions','deposits','withdrawals','internal_transfers',
    'invoice_payments','webhook_deliveries','invoices','cheque_claims','cheques','referrals',
    'subscriptions','developer_apps','wallet_addresses','balances','users','bot_sessions',
    'telegram_updates','audit_logs','system_events','rpc_health_checks',
    'unmatched_deposits','rate_limits','security_events','blocked_users','scan_cursors','address_pool'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('truncate table public.%I restart identity cascade', t);
    end if;
  end loop;
  delete from public.admin_settings where key like 'scan_state:%' or key like 'balance_view:%';
end $$;

select
  (select count(*) from public.users)            as users,
  (select count(*) from public.wallet_addresses) as addresses,
  (select count(*) from public.ledger_entries)   as ledger_rows,
  (select last_value from public.wallet_index_seq) as wallet_index_kept;
```

(If `address_pool` was already imported, remove it from the list before running so the pool survives.) After the wipe: old users who press an old button are re-registered automatically with new wallet indexes, sessions and API keys start empty, and the scanner cursors are re-created at the current chain head.

---

## 12. Tests and checks

1. `qr-png.test.ts` (Part 3), `keyboards.test.ts` for the new withdraw coin list (only held coins, never token groups), chain picker labels with fees, and the fee-gate screen.
2. Unit tests: `xs_request_withdrawal` error mapping in the handler (`FEE_CHANGED`, `BELOW_MIN`, `DAILY_LIMIT`), address rejections (own deposit address, token contract, burn address), contract validators per family, symbol validator rejecting `ΤΕSТ` style look-alikes, `contractTail`.
3. SQL checks after migration 0005: unique `(network_id, contract_address)`, native-symbol rule, `xs_list_token_v2` refusing a changed contract, `xs_rate_limit` counting correctly.
4. Repo greps that must return nothing: `toBuffer`, `XSTRIS_MASTER_MNEMONIC`, `Math.random` (inside `src/lib/xstris` and `src/routes/api`), `ilike("username"`, `is_admin` used for permission, `7206619137`, `not activated yet`, `Support for this chain`.
5. Manual test script in Telegram, and report the result of each: brand-new user `/start` gets a reply within a few seconds; Deposit → USDT → BNB Smart Chain shows a full wallet address, the contract tail and the note; Show QR code sends a PNG that scans back to that address, with Back working; Withdraw with no balance; Withdraw with a balance below the fee (blocked with the fee-gate screen); Withdraw with enough balance through to the confirm screen; admin changes a fee and the next confirm screen shows the new fee; list a test token through the wizard including one deliberate symbol mismatch.

## 13. Final summary to return

Per part: what changed, files touched, migrations added, secrets I must set (`XSTRIS_EVM_XPUB`), the before/after timing numbers (p50 and max) for `menu`, `wallet`, `dep`, `wd`, the list of fee defaults you set in Part 5, anything you could not verify (external APIs, `waitUntil` support, cron), and which seeded contracts failed `/verify_listings`.
