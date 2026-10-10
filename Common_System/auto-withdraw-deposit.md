# AUTO DEPOSIT + AUTO WITHDRAW — kaise kaam karta hai (Telegram Mini App, Lovable backend)

> **Lovable ko bolo:** "Pehle repo ka existing deposit/withdraw/scan code padho. Is file se compare karo. Jo section missing ya alag hai use is file ke hisaab se fix/implement karo. Existing user data delete mat karo. Kaam ke end me section 11 ka checklist chalao aur edge functions deploy karo."
>
> **Note (honest):** GitHub se zip (`ominiaibot-main (3).zip`) automated tool se open nahi ho paya (site automated access block karti hai). Isliye ye file OminiAi ke pichle chats ki details (ETH/BSC/TON deposit, NodeReal + TonCenter, memo `OMA-{userid}`, USDT BEP20/TON withdraw, fake-token verify) + official API docs pe based hai. Repo ke code ke saath compare Lovable karega (upar ka prompt).

---

## 1. Poora flow (ek nazar me)

```
AUTO DEPOSIT
User deposit page → chain + asset select → address (+memo) dikhta hai
   │                                        (EVM = user ka index se derived address, TON = shared address + memo)
   ▼
User wallet se paisa bhejta hai (ya TonConnect se)
   ▼
Scanner (cron 30s, Lovable Job) ─ chain API se naye incoming transfers
   ├─ fake/unknown token? → IGNORE
   ├─ memo/address match? → user mila
   ├─ confirmations pure? amount ≥ min?
   └─ credit_deposit() RPC (atomic, duplicate-safe) → coins credit → bot DM + referral bonus

AUTO WITHDRAW
User withdraw request → request_withdrawal() RPC (validate + balance hold, ek transaction)
   ▼
Auto-rule pass? ── haan → status=queued ── payout worker (ek time pe ek) ── chain pe send
   │                                                         ▼
   └─ nahi → admin pending queue (approve/reject)        confirm → paid → bot DM + payment channel post
```

Dono taraf: **server hi source of truth**, client sirf status dikhata hai.

---

## 2. Supported chains / assets (default, admin se badal sakta hai)

| Direction | Chain | Assets | Method |
|---|---|---|---|
| Deposit | BSC (BEP20) | BNB, USDT, USDC | per-user HD address (`wallet_index`) |
| Deposit | Ethereum (ERC20) | ETH, USDT, USDC | per-user HD address |
| Deposit | TON | TON (label GRAM ho sakta hai), USDT jetton | **ek shared address + memo `{PREFIX}-{userid}`** |
| Withdraw | BSC | USDT BEP20 | hot wallet se |
| Withdraw | TON | USDT jetton | hot wallet se |

Chain/asset ki list **`assets` table** me hoti hai (hardcode nahi). Naya asset sirf contract address ke saath add hota hai (section 4.4).

### 2.1 `assets` table + seed

```sql
create table assets (
  id serial primary key,
  chain text not null,                 -- 'bsc' | 'eth' | 'ton'
  symbol text not null,
  kind text not null,                  -- 'native' | 'token'
  address_raw text,                    -- token contract / jetton master (raw form), native = null
  decimals int not null,
  min_deposit_usd numeric default 0.01,
  min_withdraw_usd numeric default 0.1,
  can_deposit boolean default true,
  can_withdraw boolean default false,
  enabled boolean default true,
  unique (chain, address_raw)
);
```

| chain | symbol | kind | address (**official explorer se verify karke hi enable karo**) | decimals |
|---|---|---|---|---|
| bsc | BNB | native | — | 18 |
| bsc | USDT | token | `0x55d398326f99059fF775485246999027B3197955` | 18 |
| bsc | USDC | token | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 |
| eth | ETH | native | — | 18 |
| eth | USDT | token | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| eth | USDC | token | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| ton | TON | native | — | 9 |
| ton | USDT | token | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (jetton master; code me raw form `0:...` me convert) | 6 |

> Decimals aur address hamesha DB se; token ke apne metadata pe bharosa nahi.

---

## 3. Base URLs + APIs (kaun sa API kis kaam ke liye)

| Provider | Base URL | Auth | Kaam |
|---|---|---|---|
| **TonCenter v3** | `https://toncenter.com/api/v3` | header `X-API-Key: {TONCENTER_API_KEY}` (bina key ~1 RPS) | TON incoming txs, jetton transfers (deposit + payout confirm) |
| **TonCenter v2** | `https://toncenter.com/api/v2/jsonRPC` | `apiKey` (TonClient option) | `getSeqno`, `sendBoc` (payout) |
| **TonAPI** | `https://tonapi.io/v2` | `Authorization: Bearer {TONAPI_KEY}` | jetton wallet address lookup, jetton metadata, fallback scan |
| **NodeReal BSC** | `https://bsc-mainnet.nodereal.io/v1/{BSC_API}` | key URL me | `nr_getTransactionByAddress`, standard `eth_*` RPC (payout) |
| **NodeReal ETH** | `https://eth-mainnet.nodereal.io/v1/{ETH_API}` | key URL me | same |
| **Binance price** | `https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT` | none | native coin USD price (alt: `https://data-api.binance.vision`) |
| **Telegram Bot API** | `https://api.telegram.org/bot{BOT_TOKEN}/{method}` | token URL me | DM, payment-channel post |
| **Explorer links** | `https://bscscan.com/tx/{hash}` · `https://etherscan.io/tx/{hash}` · `https://tonviewer.com/transaction/{hash}` | none | notification me tx link |

**Lovable Cloud secrets (Cloud tab → Secrets):** `TONCENTER_API_KEY`, `TONAPI_KEY`, `BSC_API`, `ETH_API`, `BOT_TOKEN`, `HD_MNEMONIC` (ya `HD_XPUB_EVM`), `PAYOUT_EVM_MNEMONIC`, `PAYOUT_TON_MNEMONIC`, `WEBHOOK_SECRET`. Frontend/Cloudflare me inme se kuch nahi.

Rules for all calls: timeout 10s, **429/5xx par exponential backoff + jitter**, API key hamesha, ek provider fail ho to doosra (TON: TonCenter ↔ TonAPI).

```ts
// _shared/http.ts
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function getJson(url: string, init: RequestInit = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) { await sleep(500 * 2 ** i + Math.random() * 300); continue; }
      if (!r.ok) throw new Error(`http_${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  throw new Error("retry_exhausted");
}
```

---

## 4. AUTO DEPOSIT — kaise hota hai

### 4.1 Address kaise milta hai (DB me sirf index)

- DB: `users.wallet_index` (sequence), address kabhi save nahi.
- **EVM (BSC/ETH):** address = HD derive(`m/44'/60'/0'/0/{index}`). Same address BSC aur ETH dono pe valid (EVM).
- **TON:** derive nahi. `settings.ton_deposit_address` (shared) + memo `{PREFIX}-{userid}`.

```ts
import { HDNodeWallet } from "ethers";
// simple: mnemonic env me
export const evmAddress = (i: number) =>
  HDNodeWallet.fromPhrase(Deno.env.get("HD_MNEMONIC")!, undefined, `m/44'/60'/0'/0/${i}`).address;
// better: sirf xpub env me (mnemonic server pe nahi)
// HDNodeWallet.fromExtendedKey(HD_XPUB_EVM).deriveChild(0).deriveChild(i).address
```
`cached("addr:evm:"+i, forever, ...)` (Redis/in-memory): derive baar baar nahi.

Index lazy assign: user ne pehli baar deposit page khola tab:
```sql
update users set wallet_index = nextval('wallet_index_seq') where id = $1 and wallet_index is null returning wallet_index;
```

### 4.2 User UI flow

1. Chain select → asset select (native / stable).
2. Page dikhata hai: address, QR (client-side generate), TON ho to **memo bhi (copy button)**, "kam se kam {min}" note, live rate (1 native = X USDT = Y coin).
3. **Check Deposit** button (ActionButton: click → disabled + spinner): server pe `POST check_deposit` → rate limit 1/10s → "scan-now" job queue karta hai → UI 3-5s poll karke `deposits` status dikhata hai. Ye button chain API ko seedha call nahi karta.
4. Credit hone par bot DM + toast.

### 4.3 Scanner design (429 se bachne ka tareeka)

- **Ek central cron** (Lovable Job / scheduled function, har 30s). User ke hisaab se API call nahi.
- State `scan_state(chain, cursor, updated_at)`: TON me `last_lt`, EVM me `last_block`.
- **TON:** sirf ek shared address scan hota hai (sasta).
- **EVM:** *watch-set* (jin users ne pichle 30 min me deposit page khola, Redis set `watch:evm` TTL 30m) 20-30s me, baaki purane depositors 5-10 min me.
- Credit ke saath hi cursor aage badhta hai (idempotent, dobara scan safe).

### 4.4 Fake token / extra deposit ignore (rules)

| Case | Action |
|---|---|
| Token contract/jetton master `assets` whitelist me nahi | **IGNORE** (credit nahi, DB row nahi, sirf counter) |
| Naam/symbol same par address alag (fake USDT) | IGNORE (address se match hota hai, naam se nahi) |
| Outgoing transfer (user ke apne address se bheja gaya) | IGNORE (sirf `to == hamara address`) |
| Memo galat/missing (TON) | IGNORE; agar asset whitelisted aur amount ≥ min to `deposit_review` (7 din TTL) me daalo, admin manually credit kare |
| Amount < min | Credit nahi; `deposit_review` + user ko message "below minimum" |
| Failed/aborted tx | IGNORE |
| Dust/zero value | IGNORE |
| Duplicate tx hash | `unique(chain, tx_hash)` se skip |

Address compare **raw form** me: TON `Address.parse(x).toRawString()`, EVM lowercase.

### 4.5 TON scanner — example code

```ts
import { Address, Cell } from "@ton/core";
const TC = "https://toncenter.com/api/v3";
const tcHeaders = () => ({ "X-API-Key": Deno.env.get("TONCENTER_API_KEY")! });
const q = (path: string, p: Record<string, string | number>) => {
  const u = new URL(TC + path); for (const [k, v] of Object.entries(p)) u.searchParams.set(k, String(v)); return u.toString();
};

// forward_payload / body se text comment nikalo (op 0 = text comment)
function commentOf(boc?: string | null): string | null {
  if (!boc) return null;
  try {
    const s = Cell.fromBase64(boc).beginParse();
    if (s.remainingBits >= 32 && s.loadUint(32) === 0) return s.loadStringTail();
  } catch { /* ignore */ }
  return null;
}

export async function scanTon(db: any, assets: Map<string, any>, prefix: string, minOf: (a: any) => number) {
  const addr = await getSetting("ton_deposit_address");
  const cursor = await db.getCursor("ton");                       // last_lt

  // ---- 1) native TON incoming ----
  const tx = await getJson(q("/transactions", { account: addr, start_lt: cursor + 1, sort: "asc", limit: 100 }), { headers: tcHeaders() });
  for (const t of tx.transactions ?? []) {
    const m = t.in_msg; if (!m?.source) continue;                  // external/no source = ignore
    if (t.description?.aborted) continue;
    const comment = m.message_content?.decoded?.comment ?? commentOf(m.message_content?.body);
    await handleIncoming({ chain: "ton", symbol: "TON", raw: null, amountUnits: BigInt(m.value ?? 0), comment, txHash: t.hash, lt: Number(t.lt) });
  }

  // ---- 2) jetton (USDT etc.) incoming ----
  const jt = await getJson(q("/jetton/transfers", { owner_address: addr, direction: "in", start_lt: cursor + 1, sort: "asc", limit: 100 }), { headers: tcHeaders() });
  for (const t of jt.jetton_transfers ?? []) {
    if (t.transaction_aborted) continue;
    const master = Address.parse(t.jetton_master).toRawString();
    const asset = assets.get(`ton:${master}`);
    if (!asset || !asset.enabled) { await bump("ign:unlisted_token"); continue; }       // FAKE TOKEN → ignore
    const comment = t.decoded_forward_payload?.comment ?? commentOf(t.forward_payload);
    await handleIncoming({ chain: "ton", symbol: asset.symbol, raw: master, amountUnits: BigInt(t.amount), comment, txHash: t.transaction_hash, lt: Number(t.transaction_lt) });
  }
  // cursor update handleIncoming ke baad max(lt) se (ek transaction me)
}
```
> Builder note: TonCenter response ke field names (`decoded`, `forward_payload` format) pehli baar real call se **ek sample log karke confirm karo**; `commentOf()` dono jagah try karta hai.

`handleIncoming` (common, TON + EVM):
```ts
async function handleIncoming(x: { chain: string; symbol: string; raw: string | null; amountUnits: bigint; comment?: string | null; userId?: number; txHash: string }) {
  const asset = await findAsset(x.chain, x.symbol, x.raw); if (!asset) return;
  const amount = Number(x.amountUnits) / 10 ** asset.decimals;               // paisa ke liye string-decimal lib use karo
  const userId = x.userId ?? Number(new RegExp(`^${PREFIX}-(\\d+)$`).exec(x.comment ?? "")?.[1]);
  if (!userId) return review(x, "no_memo");
  const usd = await toUsd(asset, amount);                                      // stable=amount, native=amount*price (cached 60s)
  if (usd < asset.min_deposit_usd) return review(x, "below_min");
  const coins = usd * Number(await getSetting("coin_per_usd"));               // e.g. 100
  const res = await db.rpc("credit_deposit", { p_user: userId, p_chain: x.chain, p_asset: asset.symbol, p_amount: amount, p_usd: usd, p_coins: coins, p_tx: x.txHash, p_memo: x.comment ?? null, p_ref_bonus_pct: Number(await getSetting("referral_deposit_bonus_pct")) });
  if (res.status === "credited") await enqueue("notify_deposit", { userId, amount, symbol: asset.symbol, tx: x.txHash, chain: x.chain });
}
```

### 4.6 EVM scanner (BSC/ETH) — NodeReal

`nr_getTransactionByAddress` params: `category` (`["external","20"]`), `addressType` (`"to"`), `address`, `order`, `maxCount` (hex, max 0x3E8), `fromBlock`/`toBlock` (hex ya `latest`), `pageKey` (pagination). Sirf BSC aur ETH mainnet pe supported.

```ts
const nrUrl = (c: "bsc" | "eth") => `https://${c}-mainnet.nodereal.io/v1/${Deno.env.get(c === "bsc" ? "BSC_API" : "ETH_API")}`;
async function rpc(c: "bsc" | "eth", method: string, params: unknown[]) {
  const j = await getJson(nrUrl(c), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message); return j.result;
}

export async function scanEvmAddress(c: "bsc" | "eth", userId: number, address: string, fromBlock: number) {
  const latest = parseInt(await rpc(c, "eth_blockNumber", []), 16);
  const need = Number(await getSetting(`confirmations_${c}`));             // bsc 15 / eth 12 (default)
  let pageKey: string | undefined;
  do {
    const r = await rpc(c, "nr_getTransactionByAddress", [{
      category: ["external", "20"], addressType: "to", address, order: "asc",
      maxCount: "0x64", fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", ...(pageKey ? { pageKey } : {}),
    }]);
    for (const t of r.transfers ?? []) {
      if (latest - parseInt(t.blockNum, 16) < need) continue;                // confirmations kam → agle round me
      if ((t.to ?? "").toLowerCase() !== address.toLowerCase()) continue;    // sirf incoming
      const isToken = t.category === "20";
      const contract = isToken ? (t.contractAddress ?? "").toLowerCase() : null;
      const asset = await findAsset(c, isToken ? null : nativeSymbol(c), contract);
      if (!asset) { await bump("ign:unlisted_token"); continue; }          // FAKE TOKEN → ignore
      await handleIncoming({ chain: c, symbol: asset.symbol, raw: contract, amountUnits: BigInt(t.value), userId, txHash: t.hash ?? t.transactionHash });
    }
    pageKey = r.pageKey;
  } while (pageKey);
}
```
> Builder note: `hash`/`contractAddress` field names ek real response se confirm karo (docs snippet me sab fields nahi dikhe). Native BNB/ETH transfer me contract-call (input data) wali tx ko ignore karo (sirf plain transfer).

Price helper:
```ts
export async function usdPrice(sym: "BNB" | "ETH" | "TON") {
  return cached(`px:${sym}`, 60, async () => Number((await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`)).price));
}
```

### 4.7 `credit_deposit` RPC (atomic, duplicate-safe)

```sql
create table deposits (
  id bigserial primary key, user_id bigint not null, chain text not null, asset text not null,
  amount numeric(30,9) not null, usd_value numeric(20,6), coins numeric(30,9),
  tx_hash text not null, memo text, status text not null default 'credited', created_at timestamptz default now(),
  unique (chain, tx_hash)
);
create table deposit_review (   -- 7 din TTL (cron delete)
  id bigserial primary key, chain text, symbol text, amount numeric, tx_hash text, memo text, reason text,
  user_id bigint, created_at timestamptz default now(), unique (chain, tx_hash)
);

create or replace function public.credit_deposit(
  p_user bigint, p_chain text, p_asset text, p_amount numeric, p_usd numeric, p_coins numeric,
  p_tx text, p_memo text, p_ref_bonus_pct numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_ref bigint;
begin
  if not exists (select 1 from users where id = p_user and not is_banned) then
    return jsonb_build_object('status','no_user');
  end if;
  insert into deposits(user_id,chain,asset,amount,usd_value,coins,tx_hash,memo)
  values (p_user,p_chain,p_asset,p_amount,p_usd,p_coins,p_tx,p_memo)
  on conflict (chain, tx_hash) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  perform adjust_balance(p_user,'COIN',p_coins,'deposit','deposit:'||p_chain||':'||p_tx);
  update users set total_deposit = coalesce(total_deposit,0) + p_usd where id = p_user;

  select referrer_id into v_ref from users where id = p_user;
  if v_ref is not null and p_ref_bonus_pct > 0 then
    perform adjust_balance(v_ref,'COIN',p_coins * p_ref_bonus_pct / 100,'ref_deposit_bonus','refdep:'||p_chain||':'||p_tx);
  end if;
  return jsonb_build_object('status','credited','id',v_id,'coins',p_coins);
end $$;
revoke all on function public.credit_deposit(bigint,text,text,numeric,numeric,numeric,text,text,numeric) from public, anon, authenticated;
```
(`adjust_balance` = CORE_METHODS.md M8 wala atomic function.)

### 4.8 TonConnect se deposit (optional, TON)

User wallet connect → `sendTransaction` me `address = ton_deposit_address`, `amount`, `payload` = comment cell (`{PREFIX}-{userid}`). Wapas aane par app deposit status poll karta hai (scanner credit karega). Manual "I paid" button nahi. Detail code: CORE_METHODS.md M12/M7.

---

## 5. AUTO WITHDRAW — kaise hota hai

### 5.1 Request (ek RPC, ek transaction)

Checks (sab server pe): user not banned, `verify_state='human'`, account age ≥ `min_account_age_hours`, amount ≥ min, address valid (EVM `isAddress` checksum; TON `Address.parse`), network allowed, pending withdraw limit, **free-withdraw cap** (jinhone kabhi deposit nahi kiya: lifetime cap, admin setting), daily cap.

```sql
create table withdrawals (
  id bigserial primary key, seq int generated always as identity,
  user_id bigint not null, network text not null,            -- 'bsc_usdt' | 'ton_usdt'
  amount numeric(30,9) not null, fee numeric(30,9) not null default 0,
  address text not null,
  status text not null default 'pending',                    -- pending|queued|sending|sent|paid|rejected|needs_review
  attempt int default 0, raw_tx text, tx_hash text, valid_until bigint, ton_seqno bigint,
  reject_reason text, refunded boolean default false, auto boolean default false,
  created_at timestamptz default now(), processed_at timestamptz, processed_by bigint
);
create index on withdrawals (status, created_at) where status in ('pending','queued','sending','sent');

create or replace function public.request_withdrawal(p_user bigint, p_network text, p_amount numeric, p_address text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_fee numeric; v_id bigint; v_auto boolean; v_lim numeric; v_state text;
begin
  perform 1 from users where id = p_user for update;                       -- per-user serialize
  select verify_state into v_state from users where id = p_user and not is_banned;
  if v_state is distinct from 'human' then return jsonb_build_object('error','not_verified'); end if;
  -- (min/age/cap/pending checks yaha; settings public.get_setting('key'))
  v_fee := public.calc_fee(p_network, p_amount);                           -- flat ya percent (setting)
  insert into withdrawals(user_id,network,amount,fee,address) values (p_user,p_network,p_amount,v_fee,p_address) returning id into v_id;
  perform adjust_balance(p_user,'USDT',-(p_amount+v_fee),'withdraw_hold','withdrawal:'||v_id);   -- insufficient_funds => poora rollback
  -- auto rule
  v_auto := public.get_setting('autopay_enabled')::boolean and p_amount <= public.get_setting('autopay_limit_usd')::numeric;
  if v_auto then update withdrawals set status='queued', auto=true where id=v_id; end if;
  return jsonb_build_object('id',v_id,'status', case when v_auto then 'queued' else 'pending' end);
end $$;
```

### 5.2 Auto-pay rule (settings se)

`autopay_enabled` AND `amount ≤ autopay_limit_usd` AND user `human` AND not flagged/frozen AND address valid AND hot-wallet balance + gas kaafi AND daily payout cap bacha ho. Warna `pending` → admin approve karega (approve = `queued`).

### 5.3 Payout worker (queue, ek time pe ek)

- Cron har 10s. Lease lock (pooler-safe):
```sql
create table locks (name text primary key, until timestamptz not null);
-- acquire (row mila = jeet gaye)
insert into locks(name, until) values ($1, now() + interval '90 seconds')
on conflict (name) do update set until = excluded.until where locks.until < now() returning name;
```
- Lock `payout_bsc` aur `payout_ton` alag (chains parallel, har chain me ek-ek).
- `select ... where status='queued' order by id limit 1 for update skip locked` → `sending`.
- Result: `sent` (broadcast ho gaya) → confirm → `paid`. Fail → retry backoff (10s, 30s, 2m, 10m) phir `needs_review` + admin DM.
- **Stuck recovery cron:** `sending` > 10 min → confirm-check chalao; confirm na mile to `needs_review` (blind retry nahi).

### 5.4 BSC USDT payout (ethers v6) — double-pay-proof tareeka

Idea: tx **pehle sign karo, raw tx + hash DB me save karo, phir broadcast**. Retry = wahi raw tx dobara broadcast (same nonce/hash) → duplicate payment nahi ho sakta.

```ts
import { JsonRpcProvider, Wallet, HDNodeWallet, Contract, Interface, parseUnits, isAddress, getAddress, Transaction } from "ethers";
const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export async function payBscUsdt(w: any, asset: any) {
  const provider = new JsonRpcProvider(nrUrl("bsc"));
  const hot = HDNodeWallet.fromPhrase(Deno.env.get("PAYOUT_EVM_MNEMONIC")!, undefined, "m/44'/60'/0'/0/0").connect(provider);

  if (w.raw_tx) {                                                       // pehle sign ho chuka → rebroadcast
    await provider.broadcastTransaction(w.raw_tx).catch(e => { if (!/already known|nonce too low|known transaction/i.test(String(e))) throw e; });
    return confirmEvm(provider, w);
  }
  if (!isAddress(w.address)) throw new Error("bad_address");
  const to = getAddress(w.address);
  const units = parseUnits(String(w.amount), asset.decimals);

  // pre-checks: token balance + gas balance
  const tokenBal: bigint = await new Contract(asset.address_raw, ERC20, provider).balanceOf(hot.address);
  if (tokenBal < units) throw new Error("hot_wallet_low_token");

  const data = ERC20.encodeFunctionData("transfer", [to, units]);
  const nonce = await provider.getTransactionCount(hot.address, "pending");
  const gasLimit = (await provider.estimateGas({ from: hot.address, to: asset.address_raw, data })) * 12n / 10n;
  const populated = await hot.populateTransaction({ to: asset.address_raw, data, nonce, gasLimit });
  const raw = await hot.signTransaction(populated);
  const hash = Transaction.from(raw).hash!;

  await db.from("withdrawals").update({ raw_tx: raw, tx_hash: hash, status: "sending" }).eq("id", w.id).is("raw_tx", null);   // PEHLE save
  await provider.broadcastTransaction(raw);                                                                                   // PHIR send
  return confirmEvm(provider, { ...w, tx_hash: hash });
}

async function confirmEvm(provider: JsonRpcProvider, w: any) {
  for (let i = 0; i < 20; i++) {                                        // ~60s; baaki cron confirm karega
    const r = await provider.getTransactionReceipt(w.tx_hash);
    if (r && r.status === 1) { await markPaid(w.id, w.tx_hash); return; }
    if (r && r.status === 0) throw new Error("tx_reverted");
    await sleep(3000);
  }
  await db.from("withdrawals").update({ status: "sent" }).eq("id", w.id);         // cron aage check karega
}
```
Hot wallet me BNB (gas) hona zaruri. Kam ho to payouts pause + admin alert.

### 5.5 TON USDT payout (jetton transfer)

Rules: `query_id = withdrawal id`, `valid_until` chhota (120s), seqno save, retry se pehle chain check.

```ts
import { TonClient, WalletContractV4, internal, SendMode } from "@ton/ton";
import { Address, beginCell, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";

async function jettonWalletOf(owner: string, master: string) {            // TonAPI
  const j = await getJson(`https://tonapi.io/v2/accounts/${owner}/jettons/${master}`, { headers: { Authorization: `Bearer ${Deno.env.get("TONAPI_KEY")}` } });
  return Address.parse(j.wallet_address.address);
}

export async function payTonUsdt(w: any, asset: any) {
  const kp = await mnemonicToPrivateKey(Deno.env.get("PAYOUT_TON_MNEMONIC")!.split(" "));
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  const client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC", apiKey: Deno.env.get("TONCENTER_API_KEY") });
  const c = client.open(wallet);

  // 0) pichla attempt tha? chain pe pehle check
  if (w.valid_until) {
    if (await sentOnChain(wallet.address.toString(), asset, w)) return markPaid(w.id, null);
    if (Date.now() / 1000 < w.valid_until + 30) return;                       // abhi expire nahi hua → wait
    if ((await c.getSeqno()) > Number(w.ton_seqno)) throw new Error("seqno_moved_review");   // kuch aur chala → manual review
  }
  const to = Address.parse(w.address);                                         // invalid = throw
  const units = BigInt(Math.round(Number(w.amount) * 10 ** asset.decimals));
  const jw = await jettonWalletOf(wallet.address.toString(), asset.address_raw);

  const body = beginCell()
    .storeUint(0xf8a7ea5, 32).storeUint(BigInt(w.id), 64)                      // query_id = withdrawal id
    .storeCoins(units).storeAddress(to).storeAddress(wallet.address)           // response_destination = hot wallet (excess wapas)
    .storeBit(0).storeCoins(1n)                                                // custom_payload none, forward_ton = 1 nanoTON
    .storeBit(1).storeRef(beginCell().storeUint(0, 32).storeStringTail(`WD-${w.id}`).endCell())   // forward payload = comment
    .endCell();

  const seqno = await c.getSeqno();
  const validUntil = Math.floor(Date.now() / 1000) + 120;
  await db.from("withdrawals").update({ status: "sending", ton_seqno: seqno, valid_until: validUntil }).eq("id", w.id);   // PEHLE save
  await c.sendTransfer({
    seqno, secretKey: kp.secretKey, timeout: validUntil,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [internal({ to: jw, value: toNano(String(await getSetting("ton_payout_gas_attach"))), bounce: true, body })],   // default 0.1 TON, excess wapas aata hai
  });
  await db.from("withdrawals").update({ status: "sent" }).eq("id", w.id);
}

async function sentOnChain(hot: string, asset: any, w: any) {                  // TonCenter jetton transfers (out)
  const r = await getJson(q("/jetton/transfers", { owner_address: hot, direction: "out", jetton_master: asset.address_raw, start_utime: Math.floor(new Date(w.created_at).getTime() / 1000) - 60, limit: 50, sort: "desc" }), { headers: tcHeaders() });
  return (r.jetton_transfers ?? []).some((t: any) => String(t.query_id) === String(w.id) && !t.transaction_aborted);
}
```
`sent` → cron `sentOnChain` se confirm → `paid` (tx hash `transaction_hash` save, `tonviewer` link).
> Builder note: `@ton/ton` version ke hisaab se `sendTransfer` ke args (`timeout`, `sendMode`) check karo. Edge (Deno) me heavy ho to payout worker alag chhote function me rakho.

### 5.6 Approve / Reject (admin)

| Action | Kya hota hai |
|---|---|
| Approve (pending) | status=`queued` (auto-worker bhejega) **ya** "Mark Paid manually" (tx hash daalo) |
| Reject | Admin se poochho "Refund?" → haan: `adjust_balance(+amount+fee,'withdraw_refund','withdrawal:ID')`, `refunded=true`; status=`rejected` |
| Retry (needs_review) | Pehle on-chain check; paid mila to mark paid; nahi to naya attempt |
| Cancel queued | status=`rejected` + refund |

### 5.7 Notification (sab withdraw par)

- **User DM:** "Withdrawal #{seq} paid · {amount} USDT · {network} · tx link".
- **Payment channel post** (`settings.payment_channel_id`): masked userid (`123***89`), name/username, amount, fee, UTC time, tx hash ya explorer link, sequential number.
- Rejected par bhi DM (reason + refund info).
- Notifications queue se jaate hain (rate-limit safe), payout flow ko block nahi karte.

### 5.8 Hot wallet management

- Alag mnemonic (deposit HD se alag). Chhota float; baaki cold.
- Admin panel me live balance (native gas + USDT) per chain; low-balance alert (bot DM).
- Daily payout cap; auto limit se bade payout manual.
- Deposit addresses se sweep (optional): EVM address → main wallet (gas top-up ke baad), queue job.

---

## 6. Admin panel settings (deposit + withdraw)

| Key | Type / default | Matlab |
|---|---|---|
| `deposit_enabled` | bool · true | Deposit on/off (global) |
| `deposit_chain_enabled.{bsc,eth,ton}` | bool | Chain-wise on/off |
| `ton_deposit_address` | text | Shared TON address |
| `memo_prefix` | text · OMA | Memo format `{prefix}-{userid}` |
| `min_deposit_usd` | num · 0.01 | Minimum (asset-wise override `assets.min_deposit_usd`) |
| `confirmations_bsc` / `confirmations_eth` | int · 15 / 12 | Credit se pehle confirmations |
| `coin_per_usd` | num · 100 | 1 USD = kitne coins |
| `referral_deposit_bonus_pct` | num · 5 | Referrer ko deposit bonus % |
| `scan_interval_sec` | int · 30 | Scanner frequency |
| `watch_ttl_min` | int · 30 | Deposit page ke baad kitni der fast scan |
| `withdraw_enabled` | bool · true | Withdraw global on/off |
| `withdraw_network_enabled.{bsc_usdt,ton_usdt}` | bool | Network-wise |
| `min_withdraw_usd` | num · 0.1 | Minimum |
| `withdraw_fee_mode` / `withdraw_fee_value` | flat\|percent / num | Fee |
| `free_withdraw_cap_usd` | num · 0.25 | Bina deposit wale user ka lifetime cap (0 = band) |
| `min_account_age_hours` | int · 24 | Pehle withdraw se pehle |
| `daily_withdraw_cap_user_usd` / `daily_payout_cap_total_usd` | num | Limits |
| `autopay_enabled` | bool · false | Auto-pay on/off (shuru me off rakho) |
| `autopay_limit_usd` | num · 5 | Isse chhota auto, bada manual |
| `autopay_pause_on_error` | bool · true | Lagatar errors pe auto pause |
| `ton_payout_gas_attach` | num · 0.1 | Jetton transfer ke saath TON attach |
| `hot_wallet_min_gas.{bsc,ton}` | num | Isse kam balance pe payout pause + alert |
| `payment_channel_id` | text | Withdraw post channel |
| `maintenance_mode` | bool | Poora money flow band |

Admin ke "Autopay", "Deposit", "Withdraw" tabs ka layout: `admin_common_fircher.md`.

---

## 7. Provider failure / safe mode

- Scanner ko lagatar 3 fail → provider fallback; dono fail → `safe_mode=true`: naye credit/payout rukte hain, admin ko DM, user ko "processing" dikhta hai (kabhi "API error/429" nahi).
- Safe mode recover hone par scanner cursor se aage chalta hai (kuch miss nahi hota).

---

## 8. Security rules (is flow ke liye)

1. Credit/payout sirf backend se; frontend se kabhi nahi.
2. Har credit `unique(chain, tx_hash)` + ledger idempotency; payout `raw_tx`/`query_id` se idempotent.
3. Private key/mnemonic sirf secrets; logs me nahi; response me nahi.
4. Fake token = contract address mismatch; name pe trust nahi.
5. Withdraw address server-side validate; TON connected wallet address ho to wahi use.
6. Bade payout manual; auto limit settings se; daily cap.
7. Bot/unverified user (`verify_state != human`) ke withdraw hold.
8. Admin actions: single admin + PIN (CORE_METHODS.md M4).

---

## 9. Test plan

1. Testnet: TonCenter testnet `https://testnet.toncenter.com/api/v3`; BSC testnet endpoint `https://bsc-testnet.nodereal.io/v1/{key}`. Ya mainnet pe chhoti (≈$0.1) amounts.
2. Deposit: native, USDT, fake token (naya jetton/ERC20 same naam) → fake **credit nahi**, same tx dobara scan → duplicate nahi, galat memo → review list, min se kam → review.
3. Withdraw: valid address, galat address (block), insufficient balance, double-click (ek hi request), auto limit ke andar/bahar, reject+refund.
4. Payout crash test: broadcast ke baad function kill → recovery cron se `paid` aaya, double payment nahi.
5. Provider down test (galat API key) → safe mode, user ko friendly message.

## 10. Common pitfalls

| Problem | Fix |
|---|---|
| Check Deposit pe 429 | Button seedha API nahi, queue + central scanner |
| Deposit gaya par credit nahi | `min_deposit` seed purani, memo case/space, asset whitelist me nahi, confirmations kam |
| Naam "GRAM" vs "TON" mismatch | Internal chain id `ton`; display label alag setting |
| USDT amount galat | Decimals DB se (BSC 18, ETH/TON 6) |
| Payout double | Pehle save phir send; retry se pehle chain check |
| Jetton transfer fail | Attach TON kam; `ton_payout_gas_attach` badhao |
| Hot wallet gas khatam | Low-balance alert + pause |

## 11. Final checklist (Lovable chalaye)

- [ ] `assets` table seeded, har asset ka address verified
- [ ] Scanner cron chal raha (TON + BSC + ETH), cursor update hota hai
- [ ] Fake token ignore, unlisted token ka koi DB row nahi
- [ ] `credit_deposit` duplicate-safe, referral bonus sahi
- [ ] `request_withdrawal` hold + auto rule sahi, concurrent 2 request me balance negative nahi
- [ ] Payout worker single-flight, `raw_tx`/`query_id` flow, stuck recovery
- [ ] Admin settings (section 6) sab editable aur cache invalidate hota hai
- [ ] DM + payment channel post sahi (masked)
- [ ] Safe mode + provider fallback tested
- [ ] Koi secret frontend/Cloudflare me nahi; edge functions deployed
