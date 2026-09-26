# OminiAi — Update Prompt 5 (New Deposit Scanner + Channel Join Gate)

Follow-up change list on top of `prompt.md`, `prompt2.md`, and `prompt4.md`. Implement all of the below completely.

---

## 1. Deposits Are Broken — Replace the Scan Method

Deposit detection is currently not working (confirmed with a real BSC test deposit). Replace the on-chain scanning logic with the method below, based on reference scripts already written and working (hosted for reference only — the real API keys are never in these files, they come from secrets):

- `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/package.json`
- `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/eth-scan.js`
- `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/bsc-scan.js`
- `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/ton-scan.js`

These are reference implementations for the *method only* — port the logic into the app's backend/edge functions properly (typed, integrated with the `deposits` table and balance-crediting pipeline), don't just drop the scripts in as-is.

### 1a. ETH & BSC — NodeReal RPC method

Both chains use a NodeReal RPC endpoint with the custom JSON-RPC method `nr_getTransactionByAddress`, requesting both native and token transfers in one call:

```js
const body = {
  jsonrpc: "2.0",
  method: "nr_getTransactionByAddress",
  params: [{
    category: ["external", "20"],   // "external" = native coin, "20" = ERC20/BEP20 tokens
    address: userDepositAddress,
    order: "desc",
    maxCount: "0x64",                // 100 in hex
  }],
  id: 1,
};

const res = await fetch(NODEREAL_ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();
const transfers = data.result?.transfers || [];
```

- `NODEREAL_ENDPOINT` for BSC: `https://bsc-mainnet.nodereal.io/v1/${BSC_API}`
- `NODEREAL_ENDPOINT` for ETH: `https://eth-mainnet.nodereal.io/v1/${ETH_API}`
- `BSC_API` and `ETH_API` are secrets (see §5) — they are the NodeReal API keys, already obtained by the developer.

**Known contract addresses (lowercase-compare when matching):**

| Chain | Asset | Contract address | Decimals |
|---|---|---|---|
| BSC | USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 |
| BSC | USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 |
| BSC | BNB (native) | `category: "external"` | 18 |
| ETH | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| ETH | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| ETH | ETH (native) | `category: "external"` | 18 |

Convert the hex `value` field from each transfer to a human-readable amount using its decimals (BigInt-safe conversion, avoid floating-point/scientific-notation bugs — see the reference `formatUnits` helper in the linked scripts).

**Deposit-only filter (critical):** for each transfer returned, only treat it as a deposit if `transfer.to` (lowercased) equals the user's own deposit address. **Ignore any transfer where `transfer.from` equals the user's deposit address** — those are the user sending funds out, not depositing, and must never be credited or even logged as a deposit.

### 1b. TON — TonCenter method

Use TonCenter's public v2 API:

```
GET https://toncenter.com/api/v2/getTransactions?address={TON_DEPOSIT_ADDRESS}&limit=20
```

(Optionally pass an API key as a query param or header if provided, for higher rate limits — see §5.)

For each transaction, inspect `in_msg` (incoming message):
- Extract the amount from `in_msg.value` (nanotons → TON, 9 decimals).
- Extract the memo/comment: check `in_msg.message` first; if absent, base64-decode `in_msg.msg_data.body`, and if its first 4 bytes are opcode `0x00000000`, the remaining bytes (UTF-8, printable-only) are the text comment. Skip encrypted comments (opcode `0x2167da4b` — memo can't be read, so the deposit can't be matched to a user and should NOT be credited).
- **Memo is mandatory for a TON deposit to be credited.** Only credit if the memo matches the expected format `OMA-{userid}` for the destination user. A TON transfer with a real value but no matching memo must not be credited to anyone (log it for admin review instead).
- Only treat it as a deposit if `in_msg.destination` is the shared TON deposit address `UQCVxhjBVJQ7ufjD1lLSZW967R1DrFvFuOtVhsECnU_lqArV`. Ignore `out_msgs` entirely (outgoing sends from that address, e.g. withdrawals, are not deposits).

### 1c. General scanning rules (all chains)

- Dedupe strictly by tx hash — a deposit already recorded in the `deposits` table must never be credited again, whether found by the cron scan or the user's manual "Check Deposit" tap.
- Poll each chain server-side on a schedule (Cloudflare Worker cron, e.g. every 1–2 min) **and** re-check on-demand when the user taps "Check Deposit" on their specific deposit page.
- On a new, valid, matched deposit: insert into `deposits` (tx hash, chain, asset, amount, USD value at time of credit, coins credited), then run it through the same convert-and-credit pipeline as before (native/stablecoin amount → USD value via live price → coins at 100x → credited to `coin_balance`, `total_deposit` incremented) — matches `prompt.md` §5 and `prompt2.md` §8.
- Verify stablecoin authenticity by contract address match (already required in `prompt2.md` §8) — the contract addresses table above is exactly that check for ETH/BSC.

---

## 2. Deposit Chains — Reduce to ETH, BSC, TON Only

Remove Polygon, Tron, and Solana entirely from the **deposit** side (chain selector, address generation display, everything) — only **Ethereum, BNB Chain, and TON** remain as deposit options going forward. (This does not change the withdrawal restriction from `prompt2.md` §8, which already limits payouts to USDT-BEP20 or USDT-TON addresses only.)

The wallet can still internally derive Tron/Solana addresses if useful for future re-enabling, but they must not be shown or scanned for deposits right now.

---

## 3. Channel Join Gate (on app open)

When a user opens the Mini App, check whether the admin has configured a **Channel** and/or a **Payment Channel** to require joining:

- If **neither** is configured by the admin, skip this entirely — no pop-up, no friction, app opens straight to home as normal.
- If **one or both** are configured, show a polished pop-up (matches app branding/theme) listing the channel(s) the user must join, each with a "Join" button (deep-links to the channel) and a **"Verify"** button.
- Tapping **Verify** calls the Bot API (`getChatMember`) to check the user's membership status in each configured channel. If verified in all required channels, dismiss the pop-up and let them into the app. If not yet joined, keep the pop-up up and show which channel(s) are still missing.
- **The bot must be added as an admin of each required channel** — `getChatMember` for a channel that the bot isn't a member/admin of will fail, so this is a hard requirement for the feature to work; note it clearly for whoever sets up the channels.
- Both channel links/IDs (Channel, Payment Channel) must be admin-editable in Settings, and this whole gate must be optional per the "if not configured, don't show it" rule above.

---

## 4. Bot Admin Requirement

Document clearly (e.g. in the admin Settings UI, next to the channel fields) that **the bot must be manually promoted to admin in any channel used for the join gate** — this isn't something the app can do on its own via the Bot API.

---

## 5. Environment Variables / Secrets (additions)

| Secret name | What goes in it |
|---|---|
| `BSC_API` | Your NodeReal BSC mainnet API key (used to build `https://bsc-mainnet.nodereal.io/v1/{BSC_API}`) |
| `ETH_API` | Your NodeReal Ethereum mainnet API key (used to build `https://eth-mainnet.nodereal.io/v1/{ETH_API}`) |
| `TON_API_KEY` *(optional)* | A TonCenter API key, if you have one, for higher rate limits on `toncenter.com/api/v2`. The scan works without it at TonCenter's public free-tier rate limit. |

(These are in addition to the `BOT_TOKEN` and `MNEMONIC` secrets already defined in `prompt.md` §12.)

---

## Summary

Do all of this in one pass: replace the ETH/BSC/TON deposit scanning with the NodeReal + TonCenter method above, strictly deposit-only (ignore outgoing sends), memo-required and dedup'd by tx hash for TON, reduce deposit chain options to ETH/BSC/TON only (§2), add the optional channel + payment-channel join-and-verify gate that only appears when configured (§3), note the bot-must-be-channel-admin requirement (§4), and wire up the new `BSC_API`/`ETH_API`/optional `TON_API_KEY` secrets (§5).
