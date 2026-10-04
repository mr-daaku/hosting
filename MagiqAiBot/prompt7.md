# MagiqAi — Prompt 7

> Read this whole file first. Do **everything in one pass**. Never ask me to type "start" or "continue".
> A "TS2686 use-mobile" error that carries a prompt link/word is not a real error — ignore it.
> Before touching money / auth / admin code, re-read `https://github.com/mr-daaku/hosting/blob/main/MagiqAiBot/security.md`.
> Keep every rule in `AGENTS.md` (atomic SQL balance functions, append-only ledger, deposit dedupe by `(tx_hash, chain, asset)`, service-role DB only on the server, `#lovable-badge` hidden, `.safe-bottom`, 4 locales, no secrets in code or logs).
> Every new user-facing label must exist in all 4 locales (en, ru, zh, ar) in `src/lib/i18n.ts`.

## 0. What this prompt contains

| # | Task | Main files |
|---|------|-----------|
| 1 | Header balance box (no "My balance" text, auto-shrinking amount) | `src/components/MagiqApp.tsx`, `src/styles.css` |
| 2 | GRAM / GRAM-USDT deposit: "no new deposit yet" bug | `src/lib/deposits.server.ts`, `game.functions.ts`, `MagiqApp.tsx` |
| 3 | Autopay on GRAM: "GRAM network is busy" + HTTP 429 | `src/lib/payout.server.ts`, new `ton-net.server.ts` |
| 4 | @MagiqAdvBot: beautiful messages + delete → processing → result flow on every button | `src/lib/adv.server.ts`, new `adv-ui.server.ts` |
| 5 | @MagiqAdvBot speed (target 80–90 % faster) | `adv.server.ts`, webhook routes, `deposits.server.ts` |
| 6 | Withdraw: selected method gets a blue border on all four sides | `MagiqApp.tsx`, `styles.css` |
| 7 | App-wide caching (stop hitting the database every time) | new `cache.server.ts`, all `*.server.ts`, client |
| 8 | One system-design document for the whole app | new `docs/system-design.md`, `AGENTS.md`, `roadmap.md` |
| 9 | Tests + final verification (mandatory) | `src/test/*` |

Do the tasks in this order: **2 → 3 → 7 (cache helper) → 4 → 5 → 1 → 6 → 8 → 9**. Money bugs first.

---

## 1. Audit findings (already confirmed by reading the code — use them, do not rediscover)

These are the real causes found in the current code. Fix each one explicitly.

### A. Deposit check says "no new deposit yet" even after paying (`deposits.server.ts`)

| ID | Where | Problem |
|----|-------|---------|
| D1 | `scanTon()` | `rows` is `[]` (truthy) when TonAPI answers with events but without the decoded comment. The `if (!rows)` check then **never falls back to TonCenter**. Fallback only runs when TonAPI throws. |
| D2 | `scanTon()` | One shared 20 s cache for the whole GRAM address. A user who pays and taps Check inside that window gets the old list from another user's earlier scan → "no new deposit". |
| D3 | `scanTon()` | Only the newest 50 events/transactions of the **shared** address are read. On a busy address the user's transfer scrolls out of those 50 and is never seen. |
| D4 | `prices()` / `credit()` | Price lookup asks Coinbase `TON-USD` and OKX `TON-USDT`. After the TON → GRAM rename (ticker `GRAM`, pairs such as `GRAMUSDT`) these can return nothing. BNB/ETH still succeed, so `priceCache` exists but has **no GRAM key** → `usd = 0` → `credit()` silently `return null`. A native GRAM deposit is found, ignored, and the user sees "no new deposit". |
| D5 | `scanUser()` | `credit()` errors are caught with only `console.error`; function returns `[]`. UI cannot tell "nothing found" from "found but failed". |
| D6 | `scanEvm()` | N+1 sequential RPC: for each of up to 50 transfers it awaits `eth_getTransactionReceipt` + `eth_blockNumber` one after another (up to ~100 calls in a row). Very slow for BEP20/ERC20 checks. |
| D7 | `scanUser()` | Memo matching is strict equality after `toUpperCase()`. A wallet that adds a space/newline or lowercases the memo is rejected. |
| D8 | `scanUser()` + `advReserved()` | A transfer whose amount equals the user's open ad order is skipped for the game deposit, silently. |

### B. Autopay: "GRAM network is busy" / 429 (`payout.server.ts`)

| ID | Problem |
|----|---------|
| P1 | One GRAM payout makes about 12–17 sequential calls to TonCenter (get_wallet_address, getAddressInformation, get_wallet_data, seqno, sendBoc, up to 6 × seqno polling, up to 6 × `transactionsByMessage`). Without an API key TonCenter allows ~1 request/second → 429. |
| P2 | Deposit scans, admin "payout wallets" card and autopay all hit the same providers at the same time with no shared throttle. |
| P3 | `requestWithdrawal` **awaits** `afterWithdrawalRequest`, so the user's request waits 20–35 s for the payout to finish. |
| P4 | A 429 bubbles up as a generic failure → the withdrawal is released and an admin alert says "Autopay failed". It should be retried automatically, not shown as a failure. |
| P5 | The USDT jetton-wallet address of the payout wallet never changes but is looked up on every payout. |

### C. @MagiqAdvBot is slow and messy (`adv.server.ts`, adv webhook)

| ID | Problem |
|----|---------|
| B1 | `answerCallbackQuery` is awaited **before** any work. |
| B2 | Every callback first runs `current(chat)` (DB read); `check()` then reads the order again, then `players`, then `rateLimit` (a DB RPC). |
| B3 | `start()` runs `game_boot` RPC + an update + `getSettings` one after another. |
| B4 | `adv.server.ts` statically imports `deposits.server.ts` and `wallet.server.ts`, which import `ethers` and `@ton/core`. Menu taps pay that cold-start cost although they need none of it. |
| B5 | Every step sends a **new** message. Old messages and the user's typed link/number are never removed, so the chat becomes a long pile of messages. No processing indicator. |
| B6 | Plain, flat texts; only a few `<b>` and `<code>`. |

### D. App-wide
| ID | Problem |
|----|---------|
| G1 | `getMe` does: `game_boot` RPC + `players` select + HD-wallet derivation + `user_deposit_addresses` upsert **on every app open**. Wallet index never changes. |
| G2 | Every server function calls the `rate_hit` RPC (a DB round trip), even cheap read endpoints (history, friends, tasks, deposit info). |
| G3 | `sendWelcome` sends the photo by URL each time (Telegram downloads `/welcome.jpg` again). Cache the Telegram `file_id`. |
| G4 | Withdraw method selection uses `ring-arcane` (not blue). |
| G5 | User-visible "TON" text still exists: `i18n.ts` `lossWarning` (4 locales: "TON memo"), `payout.server.ts` ("needs 0.04 TON", `gasSymbol: "TON"`), `wallet.server.ts` error text. |

---

## 2. TASK 1 — Header balance box

File: `src/components/MagiqApp.tsx`, the `<header>` block (the first box with `t("balance")` and `fmt(depGems + wdGems)`).

1. **Remove** the "My balance" text (`{t("balance")}`). Keep the `balance` key in i18n (do not delete other locales' text; it may be used elsewhere — if unused after this change, leave it).
2. Make **one fixed-height box** that contains only `<Gem /> amount`, vertically and horizontally centred, same height as the round logo (`h-16`). Nothing may wrap to a second line or overflow below the box.
3. Create a small reusable `FitNumber` component. It must **shrink the font** until the amount fits the box width, never grow past the max size, and re-fit on value change, on container resize (`ResizeObserver`), on language change and on orientation change.

```tsx
// src/components/FitNumber.tsx
import { useLayoutEffect, useRef, type ReactNode } from "react";

export function FitNumber({ children, max = 24, min = 11, className = "" }: { children: ReactNode; max?: number; min?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const b = box.current, t = txt.current;
      if (!b || !t) return;
      let s = max;
      t.style.fontSize = `${s}px`;
      while (t.scrollWidth > b.clientWidth && s > min) { s -= 1; t.style.fontSize = `${s}px`; }
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  });
  return (
    <div ref={box} className={`flex min-w-0 flex-1 items-center justify-center overflow-hidden ${className}`}>
      <span ref={txt} className="flex items-center gap-[0.25em] whitespace-nowrap font-display leading-none">{children}</span>
    </div>
  );
}
```

4. Header markup target:

```tsx
<div className="stone flex h-16 min-w-0 flex-1 items-center px-3">
  <FitNumber max={24} min={11}><Gem c="h-[1em] w-[1em] shrink-0" />{fmt(depGems + wdGems)}</FitNumber>
</div>
```
   The Gem icon must scale with the text (use `em` units, check `Gem` accepts the class). Keep the logo and Profile button exactly as they are.
5. If the number is still wider than the box at the minimum size (e.g. > 15 digits), show a compact form (`1.23M`, `4.5B`) **only in the header**; the Profile modal keeps the exact number.
6. Do the same box treatment for any other place where the balance is shown in a narrow box if overflow is possible (Withdraw's three small boxes: depositGems / withdrawGems / withdrawable) — use `FitNumber` with `max=16`.

**Test it** with values `0`, `999`, `12,345`, `1,234,567`, `987,654,321,012`, `999,999,999,999,999` at widths 320 px, 360 px, 390 px, in English, Russian, Chinese, and Arabic (RTL). No overflow, no wrapping, header height unchanged. Add a vitest + jsdom test that mocks `scrollWidth/clientWidth` and checks the font size goes down and stops at `min`.

---

## 3. TASK 2 — GRAM and GRAM-USDT deposits ("no new deposit yet")

### 3.1 Naming rule (read carefully)
The token is now **GRAM** (ticker changed from TON to GRAM on 15 June 2026; the network is still "The Open Network", and API hosts such as `toncenter.com` and `tonapi.io` are network APIs).

* **Change to GRAM (user-visible text only):** the `lossWarning` string in all 4 locales ("…omitting the GRAM memo…"), `payout.server.ts` error messages and `gasSymbol` ("needs 0.04 GRAM for fees", `gasSymbol: "GRAM"`), `wallet.server.ts` error text, bot messages, admin labels, comments. Search the whole repo for `\bTON\b` / `Toncoin` and fix every user-visible occurrence.
* **Do NOT rename:** API URLs, env var names (`TON_PAY_WALLET_SECRET`, `TON_PAY_ADDRESS`, `TON_API_KEY`, `TONAPI_KEY`), the DB/zod chain value `"ton"`, npm packages `@ton/*`, the USDT jetton master constant, or anything else that would break the network calls or existing database rows. Renaming those would break deposits instead of fixing them.
* The name by itself is not the only cause. The real causes are D1–D8 above. Fix all of them.

### 3.2 Use the OminiAi method as an extra source
Reference (read it): `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/ton-scan.js`.
What it does: calls TonCenter **v2** `getTransactions?address=…&limit=…`, then for every `in_msg` reads the memo with `extractMemo`: first `msg.message` (plain text comment), otherwise decode `msg_data.body` from base64, accept only op-code `0x00000000` (text comment), skip `0x2167da4b` (encrypted comment). It keeps `value` (nano → 9 decimals) and `hash`. It does **not** understand jetton (USDT) transfers.

Implement in `deposits.server.ts`:
1. `extractMemoV2(msg)` — same logic as the reference (plain `message` → body op 0 → ignore encrypted). Reuse the existing `tonComment()` for the body decode.
2. `scanTonCenterV2(address)` — native GRAM deposits from TonCenter v2 `getTransactions`, paginated (see 3.3), using the throttled network layer from Task 3.
3. Keep TonAPI events (native + USDT jetton, they carry decoded comments) and TonCenter v3 `jetton/transfers` for USDT.
4. Run **all available providers in parallel** (`Promise.allSettled`), merge, de-duplicate by the canonical transaction key, and return the union. A provider failing must never hide results from another provider.

### 3.3 Required fixes (one by one)
* **D1** — Remove the `if (!rows)` logic. Merge providers as above. A provider is "failed" only if it threw.
* **D2** — Replace the single shared 20 s cache. Keep single-flight (many users = one in-flight request) but let an **explicit user "Check deposit"** accept cached data only if it is **≤ 3 s old**; the background auto-check (every 45 s) may use up to 20 s. The cache must store `fetchedAt` and the newest transaction `lt`.
* **D3** — Paginate: TonAPI `events?limit=100&before_lt=…`, TonCenter v2 `getTransactions?limit=100&lt=…&hash=…`, TonCenter v3 `offset`. Continue until (a) the page contains only transactions already recorded in `deposits`, or (b) 7 days / 10 pages are scanned. Never silently stop at 50.
* **D4** — Price source rewrite in `prices()`:
  * Try **GRAM first, then TON** symbols on every source: Coinbase `GRAM-USD` then `TON-USD`; OKX `GRAM-USDT` then `TON-USDT`; Binance `GRAMUSDT` then `TONUSDT`; TonAPI rates (`/v2/rates?tokens=…&currencies=usd`, try `gram` then `ton`); CoinGecko as the last source. Verify each live and keep only the ones that really answer.
  * Add **stale-if-error**: keep the last good price up to 24 h; refresh in the background (stale-while-revalidate), so a deposit never waits for, or fails because of, a price API.
  * If after all this there is still no GRAM price, **do not drop the deposit**: record it (status `awaiting_price`), tell the user "Deposit found — price unavailable, will be credited automatically within a minute", and retry on the next check. (USDT/USDC never need a price.)
* **D5** — `scanUser` must return a structured result, and `checkDeposit` must pass it to the UI:

```ts
type DepositCheck =
  | { status: "credited"; credited: { asset: string; chain: string; amount: string; gems: number }[]; me: Me }
  | { status: "pending_confirmation"; found: { asset: string; amount: string }[]; me: Me }   // seen on chain, not final yet
  | { status: "awaiting_price"; found: { asset: string; amount: string }[]; me: Me }
  | { status: "none"; me: Me }                                                              // nothing found for this memo
  | { status: "busy"; me: Me };                                                             // all providers failed / rate limited
```
  UI messages (all 4 locales): credited → "+N gems credited"; pending_confirmation → "Transfer seen, waiting for confirmation"; awaiting_price → text above; none → existing "no new deposit yet"; busy → "GRAM network is busy, try again in a minute" (and do **not** count it as a user error).
* **D6** — Rewrite the EVM scan: fetch `eth_blockNumber` **once per chain**; first look up the candidate hashes in `deposits` and skip known ones; fetch receipts only for unknown hashes, in parallel with a concurrency limit of 5. Cache confirmed results for the request.
* **D7** — Memo matching: normalise both sides (trim, remove all whitespace, uppercase) and accept a comment that **contains** `PREFIX + tgId` as a whole token (regex `(^|\D)MAG-<id>(\D|$)` built from `memo_prefix`). Never match a different user's id that merely starts with the same digits.
* **D8** — If a transfer is skipped because it is reserved for an ad order, return it in `found` with `status: "reserved_for_ad"` and show an explanatory message instead of "no new deposit yet".

### 3.4 Safety rules (do not weaken)
* Credit exactly once. All providers must produce the **same canonical tx key** for the same transfer (the trace id as lowercase hex). Add a test that feeds the same transfer through TonAPI, TonCenter v2 and v3 parsers and asserts identical keys; if they could differ, normalise before the DB call. The DB unique key `(tx_hash, chain, asset)` stays the last line of defence.
* Fake tokens (symbol looks like USDT/USDC but is not the official master) stay "fake" and are never credited.
* Only transfers **to** the deposit address, successful (not aborted/bounced), and with the user's own memo.
* Minimum deposit and deposit bonus logic unchanged.

### 3.5 Optional (only if everything else is finished and passing)
Add a small "Paid but not credited? Paste transaction hash" field on the GRAM deposit page. It reuses `verifyTonHash`, and may only credit when the memo inside that transaction equals **the caller's own** memo. Rate limit 3/min. Same idempotent `credit()` path.

---

## 4. TASK 3 — Autopay on GRAM: stop "network is busy" / 429

### 4.1 New module `src/lib/ton-net.server.ts` (single door for all GRAM network calls)
All GRAM HTTP calls in `deposits.server.ts`, `payout.server.ts`, `wallet.server.ts` must go through it.

Requirements:
* One **request queue per provider** (TonCenter, TonAPI) with a minimum gap between requests: **≈1100 ms without an API key, ≈120 ms with a key**.
* Honour `Retry-After`; on 429/5xx retry with exponential backoff + jitter, max 3 tries per call.
* **Circuit breaker**: after 3 consecutive 429/5xx from a provider, skip it for 20 s and use the next provider.
* Providers: TonCenter (`X-API-Key: TON_API_KEY` if set), TonAPI (`Authorization: Bearer TONAPI_KEY` if set). If you can verify a third free provider works inside the Worker runtime (for example `@orbs-network/ton-access`), add it as the last fallback; otherwise skip it.
* Per-call timeout 8 s. Metrics counters per provider: requests, 429s, failures, last error (used by the health card in Task 7).
* Never log API keys.

```ts
// sketch
type Provider = "toncenter" | "tonapi";
export function tonFetch(p: Provider, url: string, init?: RequestInit): Promise<any>; // queued, throttled, retried
export function tonProviderHealth(): Record<Provider, { ok: boolean; last429At?: number; failures: number }>;
```

### 4.2 Fewer calls per payout (`sendUsdtTon`)
* Cache the payout wallet's **USDT jetton-wallet address in memory permanently** (computed once; it never changes). (P5)
* One call for GRAM balance, one call for USDT balance (TonAPI `/accounts/{addr}/jettons/{master}` first, TonCenter get-method as fallback). No duplicate lookups.
* One `seqno` read before sending. After `sendBoc`, poll at most **3 times, 4 s apart**, and do the explorer-hash lookup **off the critical path**: return the message hash immediately and update the withdrawal's `tx_hash` afterwards when TonCenter v3 knows it.
* `payoutWallets()` (admin card) uses the same helpers and is cached for 60 s; it must never run in parallel with a payout.

### 4.3 Move autopay off the user's request (P3)
* `requestWithdrawal` returns right after the DB function `request_withdrawal` succeeds, with a clear message: "Request created — being processed".
* The payout runs afterwards: best-effort background execution right away (use the Worker `waitUntil` if it can be reached from `src/server.ts`; otherwise a cron route using the existing `authenticateCronRequest` in `src/integrations/supabase/cron-auth.ts`, every minute) **and** the cron route as a safety net that drains `pending` autopay withdrawals.
* **One GRAM payout at a time** (a seqno can only be used once): protect with a DB lock row (`payout_lock`, 60 s expiry) or `pg_try_advisory_lock` via an RPC. Space consecutive payouts by ≥ 3 s.

### 4.4 Errors must retry, not fail (P4)
* Classify errors: `rate_limited`, `network`, `insufficient_funds`, `invalid_address`, `unknown`.
* `rate_limited` / `network` → leave (or `release_withdrawal` back to) `pending` and retry automatically with backoff: 30 s, 1 min, 2 min, 5 min, 10 min. Only after the last retry alert admins (existing buttons). The user never sees "busy" for a payout; they see status "Processing".
* `insufficient_funds` (payout wallet low) → admin alert immediately, keep user's request pending.
* **No double pay — hard rule:** the signed external message is built once; **persist `msg_hash` (new nullable column on `withdrawals`) before calling `sendBoc`**. If `sendBoc` or anything after it errors ambiguously, first check whether that message landed (TonAPI/TonCenter by message hash) before any retry; if it cannot be determined, mark the withdrawal for manual admin review and never auto-retry. Keep the existing `claim_withdrawal` / `finish_withdrawal` locking untouched.

### 4.5 Owner actions (mention them in your final answer, do not hard-code anything)
Set server secrets `TON_API_KEY` (TonCenter key) and `TONAPI_KEY` (TonAPI key). The code must still work without keys, only slower.

### 4.6 Test (mandatory)
* Unit tests with mocked `fetch`: 429 with and without `Retry-After`, 5xx, timeout, provider circuit breaker, fallback to the second provider, queue spacing (use fake timers).
* A payout test proving that two simultaneous autopay triggers produce **one** transfer.
* A test proving a 429 during `sendBoc` does not result in two transfers.
* BEP20 autopay: run the existing path once more and confirm nothing changed.
* If a funded test wallet exists, send one minimum real GRAM-USDT autopay and one BEP20 autopay and report the transaction links. If you cannot send real funds, say so in the final report — do **not** claim a real payout was tested.

---

## 5. TASK 4 — @MagiqAdvBot: beautiful messages + clean flow

Files: `src/lib/adv.server.ts` plus a new `src/lib/adv-ui.server.ts` (all texts, keyboards, builders live there).

### 5.1 Text design system
Use Telegram HTML (`parse_mode: "HTML"`). Allowed and encouraged: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<blockquote>`, `<blockquote expandable>`, `<tg-spoiler>`, `<a href>`. Escape **every** dynamic value with `esc()` (also for quotes inside attributes). Keep each message < 4000 characters.

Style rules:
* Line 1 = title: emoji + `<b>Title</b>`.
* Explanations and warnings go in `<blockquote>`; long help in `<blockquote expandable>`.
* Amounts, addresses, memos, order ids → `<code>…</code>` (tap-to-copy).
* Labels in `<i>`, values in `<b>`: `<i>Members:</i> <b>500</b>`.
* Use `<tg-spoiler>` for transaction hashes and for the payment memo preview in confirmation messages (reveals on tap), not for important instructions.
* Thin separators `━━━━━━━━━━━━` between sections, consistent emojis (📢 ads, 🔗 link, 👥 members, 💳 payment, ✅ success, ⏳ waiting, ❌ error, ⚠️ warning).
* Short sentences. No long paragraphs.

Rewrite **all** texts in this style: `/start`, kind selection, link request, link accepted/rejected, members request, order summary, coin choice, network choice, payment instructions, checking, payment received, not found yet, cancelled, expired step, rate-limit, busy, generic error. Example for the payment screen:

```html
💳 <b>Payment</b>
━━━━━━━━━━━━
<i>Amount:</i> <b><code>12.5</code> USDT</b>
<i>Network:</i> <b>GRAM</b>

<i>Send to:</i>
<code>UQ…address…</code>

<i>Memo (required):</i> <tg-spoiler><code>MAG-123456</code></tg-spoiler>

<blockquote>⚠️ Wrong network, wrong address or missing memo = lost funds.
After sending, tap <b>Check deposit</b>.</blockquote>
```

### 5.2 The flow you must implement (every button, every step)
When a user taps **any** inline button:
1. Immediately call `answerCallbackQuery` — **not awaited** (fire and forget) so the button stops spinning at once.
2. In parallel: **delete the message that holds the clicked button** and **send a processing message** that matches the action, e.g. for Check deposit: `⏳ <b>Checking your deposit…</b>` + `<i>Looking for your payment on the GRAM network.</i>`.
3. Do the work.
4. When the result is ready: **send the result message** (success, not-found/pending, or failure) and then **delete the processing message** (the user sees processing disappear and the main message appear). If sending the result fails, edit the processing message into the result instead; never leave the user with nothing.
5. Typed input (link, member count): delete the user's own message (best effort, bots may delete incoming messages in private chats) and show the matching processing text ("🔎 Verifying your channel…", "🧮 Calculating your order…") followed by the next screen.
6. Track the id of the bot's current live message per chat in a new table `adv_chat_state(tg_id bigint primary key, last_msg_id bigint, updated_at timestamptz)` (RLS on, `service_role` grants like the other tables, new migration `0008_prompt7_*.sql`). On `/start`, delete the previous live message so the chat never piles up.
7. `deleteMessage` failures (message older than 48 h, already deleted) are ignored silently.
8. Per-chat serialisation: a chat's updates are handled one at a time (in-memory promise chain per chat id). A second tap on Check deposit while one is running answers with a tiny toast "Already checking…" and does nothing else.
9. The processing text must be specific per action: create-order, choose-coin, choose-network, check-deposit, cancel, verify-link, verify-members.

### 5.3 Same principle everywhere else
* **Main bot admin buttons (`wd:pay|auto|rej|rejr` in `bot.server.ts`)**: do **not** delete the message (it holds the withdrawal data). Instead edit it in place: first to `⏳ <b>Processing…</b>` + original details, then to the final `✅ PAID` / `❌ REJECTED` / `⚠️ error` state, buttons removed while processing and on completion. Also fix the double-tap risk (the existing DB lock stays).
* **Notifications sent by the main bot** (`notify`, deposit confirmed, withdrawal paid/rejected, referral joined) → rewrite in the same design system (title, quote, `<code>` amounts, spoiler for tx hash).
* **Mini App**: every server action must show processing state in the UI, not only a wait cursor: Check deposit shows an inline "Checking the GRAM network…" status row with spinner (and the 5 result states from Task 2), Withdraw shows "Submitting…" then the final state, buy/collect buttons show the spinner (already for buy). Keep the single-action `guard`.

### 5.4 Tests
Create `src/test/adv-flow.test.ts` with mocked `advApi`: simulate callbacks and assert the exact order of calls — `answerCallbackQuery` (not awaited), then `deleteMessage(clicked)` + `sendMessage(processing)`, then `sendMessage(result)` and `deleteMessage(processing)`. Also test: double tap, failed delete, failed result send, long text, HTML escaping with `<`, `&`, quotes in a channel title.

---

## 6. TASK 5 — @MagiqAdvBot speed (target 80–90 % lower latency)

First **measure** (do this before changing anything): add a tiny timing wrapper (`t0` → stages → `console.info("adv", {action, ms, stages})`) and a vitest benchmark that runs `handleAdvUpdate` with mocked Telegram + mocked DB latency (e.g. 60 ms per DB call, 120 ms per Telegram call, 300 ms per chain call) for: `/start`, choose kind, send link, send members, choose coin, show payment, check deposit (found / not found). Record "before" numbers, apply the changes, record "after" numbers, and put both in the final report. State clearly that the numbers are from the mocked benchmark, not from production Telegram.

Changes (each one is mandatory):
1. **B1** — `answerCallbackQuery` fire-and-forget (`void`), no text.
2. **B2** — per-chat session cache: keep the active order in an in-memory `Map` (TTL 10 min, write-through on every `patch`). Callbacks that carry the order id use the cache first; DB only on a miss. Never read the same row twice in one update.
3. **B3** — run independent calls in parallel (`Promise.all`): settings + player lookup + draft cancellation + sending the message. `start()` calls `game_boot` only if the player is not in the `wallet_index` cache.
4. **Wallet cache** — `tg_id → wallet_index` and `wallet_index → evm address` are immutable: cache forever (LRU, 10k entries). Memoise `gramDepositAddress()` for 60 s. Do the `user_deposit_addresses` upsert only once per user per isolate, fire-and-forget.
5. **B4** — split modules: `adv.server.ts` (flow, light) must not import `ethers` / `@ton/*` at top level. Load `deposits.server.ts` / `wallet.server.ts` with dynamic `import()` only inside `showPayment` and `check`. Also lazy-load heavy parts inside `deposits.server.ts` (`ethers`, `Cell`) where practical.
6. **Rate limit** — use an in-memory sliding window first; use the `rate_hit` RPC only for money-moving or expensive actions (`check`).
7. **Check deposit path** — fetch order (cache), player (cache), then run TON and EVM scans in parallel where both apply; EVM scan uses the Task 2 D6 rewrite; TonAPI/TonCenter calls use the Task 3 network layer; use the ≤ 3 s cache rule for explicit checks.
8. **Webhook route** — validate the secret, parse, hand over to the handler, return `200`. If a Worker `waitUntil` is available, acknowledge immediately and finish in the background; if not, keep awaiting but make sure the handler can never exceed ~25 s (hard timeout that edits the processing message into "⏳ Still working… tap Check deposit again").
9. `setWebhook` for both bots: add `max_connections: 40` and keep `allowed_updates` minimal. Re-registration happens when the owner presses the existing setup action after publish.
10. **Welcome photo (G3)** — send the photo by URL once, store the returned Telegram `file_id` in `app_settings` (key `welcome_file_id`) and memory, and reuse it afterwards; fall back to the URL if Telegram rejects the id.
11. Preload settings, prices and the GRAM address once on isolate start (non-blocking), so the first user does not pay the cold cost.

Targets (mocked benchmark, relative to "before"): menu/step taps ≥ 80 % lower server time; first visible feedback (processing message call issued) within one DB-free tick; check-deposit ≥ 60 % lower when providers are healthy. Report real numbers; if a target is not reached, say which one and why.

---

## 7. TASK 6 — Withdraw: selected method with blue border

File: `MagiqApp.tsx` → `Withdraw` → the two method buttons (`USDT BEP20`, `USDT GRAM`).

* Selected button: **blue border on all four sides** (2 px), a soft blue glow, and a small ✓ badge in the top-right corner. Unselected buttons: normal look, no border colour.
* Add to `styles.css`:

```css
:root { --select-blue: #3b82f6; }
.method-selected { border: 2px solid var(--select-blue); box-shadow: 0 0 0 1px var(--select-blue), 0 0 14px rgba(59,130,246,.55); }
```
* Replace `ring-2 ring-arcane` on the method buttons with `method-selected` (keep the existing border-radius from `.stone`; make sure the border is visible on all four sides and not clipped by `overflow-hidden`). Add `aria-pressed={method === m}`.
* Default selection = the first method that is **not paused**; if the selected method becomes paused, the PAUSED badge stays and the blue border stays (user still sees what is selected).
* The "withdrawable" box (`ring-2 ring-arcane`) is a different element: leave it as it is.
* Test: tap BEP20 → only BEP20 blue; tap GRAM → only GRAM blue; paused method shows both PAUSED badge and blue when selected; works in RTL (Arabic) and at 320 px width.

---

## 8. TASK 7 — Caching everywhere (stop asking the database every time)

### 8.1 One cache helper: `src/lib/cache.server.ts`
Replace all ad-hoc caches (`settingsCache`, `configCache`, `adminCache`, `priceCache`, `tonCache`, `taskCache`, `joinCache`) with one helper and keep their current TTLs unless stated below.

```ts
export function cached<T>(key: string, opts: { ttl: number; stale?: number; max?: number }, load: () => Promise<T>): Promise<T>;
// - single-flight: concurrent callers share one load()
// - stale-while-revalidate: after ttl, return the old value instantly and refresh in the background (until ttl+stale)
// - stale-if-error: if load() throws and an old value exists (within stale), return it
// - bounded size (LRU) per namespace
// - counters: hits, misses, stale hits, errors per namespace  -> exposed to the admin health card
export function invalidate(prefix: string): void;
```

### 8.2 What to cache (server)
| Data | TTL | Notes |
|------|-----|-------|
| `app_settings` | 30 s + stale 5 min | Existing; invalidate on admin save. Money-critical switches (`deposits_open`, `withdrawals_open`) are still enforced inside the SQL functions. |
| `character_config` | 60 s | Existing. |
| Assembled `getConfig()` response | 15 s + stale 60 s | Add `Cache-Control: public, max-age=15, stale-while-revalidate=60` if the server function allows response headers. |
| Prices | 60 s + stale 24 h | See Task 2 D4. |
| `tg_id → wallet_index`, `index → EVM address` | forever (LRU 10k) | Immutable. |
| Admin ids | 60 s | Existing. |
| Tasks list | 30 s | Existing; also cache the per-user "completed" set for 10 s. |
| Required-channel membership | 10 min positive / 5 s negative | Existing. |
| GRAM scan (shared address) | 3 s explicit / 20 s background | See Task 2 D2. |
| Verified Telegram `initData` → user | 5 min (key = SHA-256 of initData) | Saves HMAC work; expires with `auth_date`. |
| Welcome photo `file_id` | forever | Task 5 #10. |

**Never cache** balances, withdrawals, deposits, ledger rows, or anything that changes money — always from the DB / RPC result. Action endpoints already return the fresh `Me` object; keep using that instead of re-fetching.

### 8.3 Fewer database round trips
* **G1** — `getMe`: only `game_boot` (it should already return what is needed). Remove the per-open `players` select and the `user_deposit_addresses` upsert + HD derivation; do the upsert lazily in `getDepositInfo` / scan, once per user per isolate.
* **G2** — Rate limiting: in-memory sliding window for read endpoints (`getHistory`, `getFriends`, `getTasks`, `getDepositInfo`, `checkJoin`); keep the `rate_hit` RPC for `checkDeposit`, `requestWithdrawal`, `buy*`, `collect*`, `claimReferral`, `completeTask`.
* `checkDeposit`: replace the two sequential selects (`players`, `player_state`) with one query or one RPC; run `me_json` in parallel with the scan when possible.
* Check for missing indexes (e.g. `deposits(tx_hash, chain, asset)` unique, `withdrawals(status, created_at)`, `adv_orders(tg_id, status)`, `user_deposit_addresses(chain, address)`) and add the missing ones in the new migration.

### 8.4 Client
* Use `@tanstack/react-query` (already installed) with sensible `staleTime` for `getConfig` (60 s), tasks (30 s), history (30 s), friends (30 s). Refetch on window focus only for those lists, never for balances.
* Cache the last `getConfig` result in `sessionStorage` and render from it immediately, then revalidate (stale-while-revalidate) so the app opens without waiting.
* Lazy-load rarely used code: the `/admin` route, the QR library (`qrcode.react`) and the History modal (`React.lazy` + `Suspense`).
* Avoid re-render storms: the 1 s mining ticker must not re-render the whole `MagiqApp`; move it into the small components that display live numbers (or memoise the rest).
* Keep images lazy and sized; preload only the logo and background used on the first screen.

### 8.5 Optional health card (last, only if time remains)
Admin dashboard card "System health": cache hit-rate per namespace, GRAM provider status (ok / last 429 / failures from `tonProviderHealth()`), last autopay result, price source in use, DB round-trip time.

---

## 9. TASK 8 — System-design document

Create `docs/system-design.md` (single source of truth, written in plain English with tables and ASCII diagrams) and keep it accurate with what you actually built. Required sections:
1. **Overview** — Telegram Mini App + two bots, stack (TanStack Start on Workers, Supabase, ethers, @ton), which bot does what.
2. **Request flow** — diagram: Telegram → Worker → cache → Supabase RPC; where `initData` is verified; where rate limits apply.
3. **Data model summary** — tables and the atomic SQL functions (no secrets, no row data).
4. **Money flows** — deposit (per chain: BSC/ETH per-user address, GRAM shared address + memo), crediting, dedupe key, bonus; withdrawal (request → pending → autopay/admin → paid), locks and the no-double-pay rule.
5. **GRAM network layer** — providers, throttle numbers, circuit breaker, retry table, what happens on 429.
6. **Caching** — the table from Task 7 plus invalidation rules and "never cache" list.
7. **Bot message system** — design rules from Task 4, the delete → processing → result flow, per-chat serialisation.
8. **Performance budgets** — e.g. app open < 1.5 s on 4G, tab switch < 100 ms, server action p95 < 400 ms (DB-only), check deposit p95 < 3 s (healthy providers), bot step < 300 ms server time. Say how each is measured.
9. **Failure modes & runbook** — price API down, TonAPI down, TonCenter 429, Supabase slow, payout wallet low, webhook not registered; what the user sees; what the admin does.
10. **Config & secrets** — list every env var and its purpose (names only, never values).
11. **Naming rules** — GRAM everywhere user-facing; internal `"ton"` chain key and API/env names stay.
12. **Testing** — how to run tests, which tests need real funds.

Also update `AGENTS.md` (short rules: use `cached()`, use `ton-net.server.ts` for every GRAM call, bot message flow, FitNumber, blue selection, "Next prompt: Prompt8") and `roadmap.md` (`- [x] Prompt7: …`).

---

## 10. TASK 9 — Testing and verification (mandatory — do not skip, do not fake)

### 10.1 Automated
* Add/extend vitest tests: `ton-parse.test.ts` (fixtures: TonAPI native event, TonAPI USDT jetton event with comment, TonAPI jetton event **without** comment, TonCenter v2 native tx with plain `message`, with base64 body op 0, with encrypted body, TonCenter v3 jetton transfer), `ton-net.test.ts`, `deposit-check.test.ts` (all five `DepositCheck` statuses), `price.test.ts` (GRAM symbol ok / only TON symbol ok / all fail → stale / none → `awaiting_price`), `cache.test.ts`, `adv-flow.test.ts`, `fit-number.test.tsx`, `withdraw-select.test.tsx`.
* Run and make green: `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build`.

### 10.2 Real/manual checks (do them, or state exactly which could not be done)
1. **GRAM deposit**: send a small native GRAM transfer with the user's memo → tap Check deposit → credited once → tap again → no second credit (`deposits` has one row, ledger has one row).
2. **GRAM-USDT deposit**: same with a small USDT-on-GRAM transfer including the memo.
3. Deposit **without** memo and with **wrong** memo → not credited, correct message. Lowercase/spaced memo → credited.
4. A fake token named USDT → status `fake`, not credited.
5. Simulate price API down → native GRAM deposit becomes `awaiting_price`, then credited automatically after the price returns.
6. Simulate TonAPI down, TonCenter 429, and both → UI shows `busy`, never "no new deposit"; recovery works.
7. Many users: 20 parallel checks → only one in-flight provider request (single-flight), all get correct answers.
8. BEP20/ERC20 deposit check: same result as before, measurably fewer RPC calls.
9. Autopay GRAM-USDT and BEP20 (see 4.6). Two parallel autopays → one transfer. 429 simulation → retried, not failed.
10. @MagiqAdvBot full walk-through for each kind (channel / group / bot) and each coin/network: every button → clicked message deleted, processing shown, result shown, processing removed; `/start` twice → no leftover messages; invalid link; bot not admin; below-minimum members; cancel; expired step; wrong tap order.
11. Header box: all values/widths/languages from Task 1.
12. Withdraw: blue selection from Task 6, both methods, paused state.
13. Cold-start check: open the app, then each bot, after the Worker has been idle; confirm no step exceeds the budgets in `docs/system-design.md`.
14. Security regression: no secret in logs/responses, admin-only routes still admin-only, initData still verified, rate limits still active on money endpoints, ledger still append-only.

### 10.3 Final self-verification pass (do this before you answer)
Re-read **this entire file from the top** and tick every numbered item: Task 1–9, every ID (D1–D8, P1–P5, B1–B6, G1–G5), every test in 10.1 and 10.2. For anything not done or not testable in your environment, say so plainly. **Never write "tested" for something you did not actually run.**

### 10.4 Final answer format
Reply with one table:

| Item | Done? | How verified (real / mocked / not possible) | Result |
|------|-------|--------------------------------------------|--------|

Then list: files created/changed, new migration(s), new/changed env vars, before/after benchmark numbers (Task 5), anything you could not complete, and the **owner actions**:
1. Add secrets `TON_API_KEY` (TonCenter) and `TONAPI_KEY` (TonAPI).
2. Publish the app, then run the existing bot setup so both webhooks are re-registered (with `max_connections`).
3. @MagiqAiBot must be admin in the required/advertised channels.
4. Fund the GRAM payout wallet with GRAM (fees) and USDT.
