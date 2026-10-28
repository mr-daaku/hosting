# Gift & NFT Deposit System - Build Spec

For lovable.dev. Stack: React + Vite + TypeScript, Supabase (DB + edge functions), TON Connect. Telegram Mini App.

## 0. What to build (and what NOT)

Two deposit types inside one Mini App deposit page:

1. **TON NFT deposit** - user connects a TON wallet, picks an NFT, verified server-side, user sends it to our deposit wallet with a memo, backend confirms on-chain, balance is credited.
2. **Telegram gift deposit** - user sends a Telegram gift / collectible gift to our deposit Telegram account. A separate listener service on a VPS (NOT built in Lovable) detects it and calls our webhook. Lovable builds only the webhook receiver, DB, UI and admin.

**Hard rules**

- All verification and crediting happens in Supabase edge functions with the service role. The frontend is never trusted.
- Validate Telegram `initData` (HMAC with bot token) on every user-facing function.
- No secrets in frontend code. Use Supabase secrets.
- Compare TON addresses only in raw format (`workchain:hex`).
- Credit exactly once: DB unique constraints plus one SQL function `credit_deposit(deposit_id)`.

## 1. Database (Supabase)

```sql
create table supported_collections (
  collection_address text primary key,   -- raw format
  name text not null,
  price numeric not null,                -- internal balance value per NFT
  enabled boolean default true
);

create table tg_gift_prices (
  gift_title text primary key,           -- collectible gift title, or 'regular:<gift_id>'
  price numeric not null,
  enabled boolean default true
);

create table deposits (
  id bigint generated always as identity primary key,
  tg_user_id bigint not null,
  type text not null check (type in ('ton_nft','tg_gift')),
  status text not null default 'pending',
  -- pending | awaiting_chain | awaiting_gift | holding | credited | manual_review | rejected | expired
  nft_address text,
  collection_address text,
  user_wallet text,
  memo text unique,                      -- dep_<id>
  tx_hash text unique,
  gift_slug text,
  gift_title text,
  tg_message_id bigint unique,
  amount numeric,
  reject_reason text,
  hold_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now(),
  credited_at timestamptz
);

create table balance_ledger (
  id bigint generated always as identity primary key,
  tg_user_id bigint not null,
  deposit_id bigint unique not null,     -- unique = credit only once
  amount numeric not null,
  created_at timestamptz default now()
);

create table app_settings (key text primary key, value text);
-- keys: DEPOSIT_WALLET, TG_DEPOSIT_USERNAME, HOLD_MINUTES (default 30),
-- EXPIRE_MINUTES (default 15), ALLOW_UNVERIFIED (default false)
```

RLS: users can only `select` their own rows in `deposits` and `balance_ledger`. No insert/update/delete from the client. `credit_deposit(id)` is a SECURITY DEFINER function that, in one transaction, checks status is not `credited`, inserts into `balance_ledger`, adds to the user balance, and sets status `credited`.

## 2. Flow A - TON NFT deposit

### Screens

1. Deposit page, tab **TON NFT**. Button **Connect Wallet** (TON Connect UI, tonconnect-manifest.json).
2. After connect: grid of ALL NFTs in the wallet. Each card shows image, name, collection and a badge: **Verified** (green), **Unknown** (grey, not selectable), **Scam** (red, not selectable). Only Verified cards are selectable.
3. User taps one NFT, sees value and a **Deposit** button.
4. Wallet opens (TON Connect `sendTransaction`) showing the deposit address and memo.
5. Status screen: Pending > Confirming on blockchain > Done (Supabase Realtime on the `deposits` row).

### Edge function `ton-nft-list` (POST)

- Input: wallet address. Fetch `GET https://tonapi.io/v2/accounts/{wallet}/nfts?limit=100&offset=N&indirect_ownership=false` (paginate until fewer than 100). Header `Authorization: Bearer TONAPI_KEY`.
- Classify each item with the verification rules below and return `{address, name, image, collection_name, collection_address, status}`.

### Verification rules (shared helper `verifyNft(item, wallet)`)

Fetch fresh data with `GET /v2/nfts/{item_address}`, then:

| Rule | Result |
| --- | --- |
| `trust == "blacklist"` | Scam, reject |
| Name or collection name has a word mixing Latin letters with Cyrillic/Greek/Coptic/fullwidth characters | Scam, reject (look-alike) |
| `owner.address` is not the connected wallet | Reject |
| `sale` is set (listed on a marketplace) | Reject |
| No `collection` | Reject |
| Collection is in `supported_collections` and enabled | Verified (price from table) |
| Else if `trust == "whitelist"` or `approved_by` is non-empty AND the collection has a price | Verified |
| Everything else | Unknown, not depositable |

Optional strong check: call the collection's `get_nft_address_by_index(index)` through `GET /v2/blockchain/accounts/{collection}/methods/get_nft_address_by_index?args={index}` and compare with the item address. A mismatch means fake. If the collection does not support the method, skip (do not fail).

Only collections that have a price (supported\_collections) can ever be credited. Official trust only filters scam; it does not set value.

### Edge function `ton-deposit-start` (POST)

- Auth: validate `initData`, get `tg_user_id`.
- Input: `nft_address`, `user_wallet`.
- Run `verifyNft` again (never trust the list call). If not Verified, return an error.
- Insert `deposits` row: type `ton_nft`, status `awaiting_chain`, `expires_at = now + EXPIRE_MINUTES`, then set `memo = 'dep_' || id`.
- Return `{deposit_id, memo, deposit_wallet, nft_address}`.

### Frontend: building the transfer (use `@ton/core`, add the Buffer polyfill for Vite)

```ts
import { beginCell, Address, toNano } from "@ton/core";

function buildNftDeposit(nftItem: string, userWallet: string, depositWallet: string, memo: string) {
  const body = beginCell()
    .storeUint(0x5fcc3d14, 32)                        // NFT transfer op
    .storeUint(0, 64)                                  // query_id
    .storeAddress(Address.parse(depositWallet))        // new owner
    .storeAddress(Address.parse(userWallet))           // response destination
    .storeBit(0)
    .storeCoins(toNano("0.01"))                        // forward_amount (must be > 0)
    .storeBit(1)
    .storeRef(beginCell().storeUint(0, 32).storeStringTail(memo).endCell())
    .endCell();
  return {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [{
      address: nftItem,                                // the NFT ITEM address
      amount: toNano("0.05").toString(),               // gas
      payload: body.toBoc().toString("base64"),
    }],
  };
}
// await tonConnectUI.sendTransaction(buildNftDeposit(...))
```

### Confirmation job `ton-confirm` (every 30 seconds, pg\_cron or scheduled function)

For every deposit with status `awaiting_chain` and not expired:

1. Read `GET /v2/accounts/{DEPOSIT_WALLET}/events?limit=50`. Find an action of type `NftItemTransfer` (if field names differ, adapt) where `nft` equals the deposit's NFT, `recipient` equals the deposit wallet, `sender` equals the deposit's `user_wallet`, and `comment` equals the deposit memo.
2. Confirm again with `GET /v2/nfts/{item}`: `owner.address` is now the deposit wallet.
3. Save `tx_hash` (unique) and set status `holding`.
4. When `hold_until` has passed, call `credit_deposit`.

If an NFT arrives with a wrong or missing memo, or from an unexpected sender, put it in `manual_review` (never auto credit). Expired deposits become `expired`.

## 3. Flow B - Telegram gift deposit

### Screens

- Deposit page, tab **Telegram Gift**. Shows the deposit account username (`TG_DEPOSIT_USERNAME`), instructions: "Send your gift to this account. Do NOT hide your name when sending." and a **I sent it** button that creates a pending deposit.
- History list with status for each deposit.

### Edge function `tg-deposit-start`

Validate `initData`, insert a deposit row: type `tg_gift`, status `awaiting_gift`, `expires_at = now + EXPIRE_MINUTES`.

### Edge function `tg-gift-webhook` (called only by our VPS listener)

- Auth: header `x-signature` = HMAC-SHA256 of the raw body with `WEBHOOK_SECRET`. Reject otherwise. Also reject events older than 5 minutes.
- Body from the listener:

```json
{
  "message_id": 12345,
  "kind": "unique",
  "sender_id": 111222333,
  "name_hidden": false,
  "gift_title": "Plush Pepe",
  "gift_slug": "PlushPepe-1234",
  "gift_num": 1234,
  "gift_id": null,
  "stars": null,
  "refunded": false,
  "owner_is_deposit_account": true,
  "memo_text": ""
}
```

- Logic:
  1. Insert guard: `tg_message_id` unique, so a repeated webhook does nothing.
  2. If `name_hidden` or `sender_id` is missing: status `manual_review`.
  3. If `refunded` is true or `owner_is_deposit_account` is false: `rejected`.
  4. Find the user by `sender_id` (their Telegram ID from the Mini App). Match their latest `awaiting_gift` deposit, or create one. No match: `manual_review`.
  5. Price: unique gift by `gift_title` in `tg_gift_prices`; regular gift by `regular:<gift_id>`. No price or disabled: `manual_review`.
  6. Set `amount`, `hold_until = now + HOLD_MINUTES`, status `holding`.
- A scheduled job `hold-release` runs every minute: for `holding` deposits past `hold_until`, call the VPS listener's re-check endpoint (or read a fresh status posted by it) and, if still valid and not refunded, call `credit_deposit`.

### VPS listener (NOT in Lovable)

A small Python (Telethon) service on a VPS, logged in once with the dedicated Telegram account (session stored as a secret, 2FA on). It listens for gift service messages in private chats, checks the current owner with Telegram, and POSTs the JSON above to `tg-gift-webhook`. Lovable only needs the receiver, secrets and docs for this contract.

## 4. Admin panel (admin Telegram IDs only, enforced server-side)

- **Collections**: add, edit, enable or disable supported TON collections with price.
- **Gift prices**: edit `tg_gift_prices`.
- **Deposits**: table with filters (status, type, user). **Manual review queue** with Approve (calls `credit_deposit`) and Reject (with reason).
- **Settings**: DEPOSIT\_WALLET, TG\_DEPOSIT\_USERNAME, HOLD\_MINUTES, EXPIRE\_MINUTES, ALLOW\_UNVERIFIED.

## 5. Secrets (Supabase)

`TONAPI_KEY`, `BOT_TOKEN` (initData validation), `WEBHOOK_SECRET`, `ADMIN_TG_IDS`. The deposit wallet is public, so it is a setting, not a secret.

## 6. Edge cases to handle

- Same NFT submitted twice: second deposit rejected while the first is active.
- User closes the wallet without confirming: deposit expires, no credit.
- TonAPI rate limit (429): retry with backoff, never mark as rejected because of it.
- Anything unexpected goes to `manual_review`, never to auto credit.
- Withdraw is out of scope for this version.
