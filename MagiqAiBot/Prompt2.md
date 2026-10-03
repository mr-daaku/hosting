# MagiqAi — Prompt 2 (users, index wallets, characters, magic mining, payouts, admin)

Read AGENTS.md and prompt1.md first. They stay valid. Where this prompt differs, THIS PROMPT WINS. First update AGENTS.md with the rules in section 10, then build.

## 1. New user bootstrap

When a Telegram user opens the app for the first time (`boot_user`), in ONE database transaction:
- create the user with **1000 gems** and **500 magic** (admin settings `welcome_gems`, `welcome_magic`, defaults 1000 / 500)
- give the user the next **wallet_index**: first user = 0, second = 1, third = 2 ... no gaps, no repeats
- create the user's empty `characters` row and `user_state` row
- write 2 ledger rows (welcome gems, welcome magic)
- if a valid referrer was passed (not self, exists): save `referred_by` and give the referrer the invite bonus

Wallet addresses are NEVER stored. Only `wallet_index` is stored. The address is generated on demand from the index (section 8). All EVM chains (ETH, BNB Chain) use the same per-user address.

## 2. Database (Supabase, RLS on, service_role only)

users: keep EXACTLY these columns:
```sql
create table public.users (
  id            bigint generated always as identity primary key,   -- internal id
  tg_id         bigint not null unique,                            -- Telegram id (used as FK everywhere)
  wallet_index  int    not null unique,
  gems_balance  numeric not null default 0 check (gems_balance >= 0),
  magic_balance numeric not null default 0 check (magic_balance >= 0),  -- value at user_state.last_settle_at
  total_deposit numeric not null default 0,                        -- USD
  total_withdraw numeric not null default 0,                       -- USD
  created_at    timestamptz not null default now()
);
```
Everything else lives in small side tables so `users` stays light:
```sql
create table public.user_state (
  tg_id bigint primary key references users(tg_id),
  is_banned boolean not null default false, ban_reason text,
  admin_frozen numeric not null default 0, freeze_reason text,
  gems_frozen numeric not null default 0,             -- gems held by pending withdrawals
  pending_gems numeric not null default 0,            -- mined, not collected yet
  last_settle_at timestamptz not null default now(),
  referred_by bigint, referral_unclaimed numeric not null default 0, referral_earned numeric not null default 0,
  last_seen_at timestamptz not null default now()
);
create table public.characters (                       -- how many of each character the user bought
  tg_id bigint primary key references users(tg_id),
  zyron int not null default 0, lunara int not null default 0, aetheris int not null default 0,
  mystara int not null default 0, vexora int not null default 0, elowyn int not null default 0,
  dravik int not null default 0, nyxelle int not null default 0, solvyn int not null default 0
);
create table public.character_config (                 -- editable in admin
  slug text primary key, display_name text not null, price_gems numeric not null,
  daily_pct numeric not null, gems_per_day numeric not null, enabled boolean not null default true,
  sort int not null, image_path text
);
create table public.wallet_counter (id int primary key default 1 check (id = 1), next_index int not null default 0);
insert into wallet_counter values (1, 0);
```
Also keep from prompt1: `deposits`, `withdrawals`, `ledger`, `referrals`, `app_settings`, `admins`, `broadcasts`, `device_ban`, `ip_ban`, `rate_limits`, `admin_actions`.

Rename map for ALL prompt1 code and SQL: `tg_user_id` -> `tg_id`, `total_deposit_usd` -> `total_deposit`, `total_withdrawal_usd` -> `total_withdraw`. Columns `is_banned, ban_reason, admin_frozen, gems_frozen, referred_by, last_seen_at` now live in `user_state` (join it in `withdraw_hold`, `ban_user`, admin queries).

Seed `character_config` (9 characters, names fixed; prices/income editable in admin; order = price order):

| slug | price | daily % | gems/day |
|---|---|---|---|
| zyron | 10 | 20 | 2 |
| lunara | 25 | 20 | 5 |
| aetheris | 100 | 22 | 22 |
| mystara | 250 | 24 | 60 |
| vexora | 1000 | 26 | 260 |
| elowyn | 2500 | 26 | 650 |
| dravik | 5000 | 28 | 1400 |
| nyxelle | 10000 | 28 | 2800 |
| solvyn | 50000 | 30 | 15000 |

(Home screen shows these 9 characters in a 3x3 grid instead of 12 mages. Bought = coloured with xN badge, not bought = grey silhouette.)

## 3. SQL functions (SECURITY DEFINER, search_path=public, REVOKE from public/anon/authenticated, GRANT to service_role)

```sql
create or replace function public.boot_user(p_tg bigint, p_ref bigint default null) returns json
language plpgsql security definer set search_path = public as $$
declare v_idx int; wg numeric; wm numeric; v_ok boolean := false;
begin
  perform pg_advisory_xact_lock(7001);                 -- one registration at a time => index has no gaps
  if not exists (select 1 from users where tg_id = p_tg) then
    wg := coalesce((select (value #>> '{}')::numeric from app_settings where key = 'welcome_gems'), 1000);
    wm := coalesce((select (value #>> '{}')::numeric from app_settings where key = 'welcome_magic'), 500);
    update wallet_counter set next_index = next_index + 1 where id = 1 returning next_index - 1 into v_idx;  -- 0, 1, 2 ...
    insert into users(tg_id, wallet_index, gems_balance, magic_balance) values (p_tg, v_idx, wg, wm);
    insert into characters(tg_id) values (p_tg);
    v_ok := p_ref is not null and p_ref <> p_tg and exists (select 1 from users where tg_id = p_ref);
    insert into user_state(tg_id, referred_by) values (p_tg, case when v_ok then p_ref end);
    insert into ledger(user_id, kind, gems_delta, note) values (p_tg, 'welcome_gems', wg, 'Welcome bonus');
    insert into ledger(user_id, kind, gems_delta, note) values (p_tg, 'welcome_magic', 0, 'Welcome magic +' || wm);
    -- referral invite bonus (setting ref_bonus_gems) is credited here to referral_unclaimed only if both accounts are clean
  end if;
  return (select row_to_json(x) from (select u.*, s.pending_gems, s.last_settle_at, s.is_banned, c.* from users u
          join user_state s using (tg_id) join characters c using (tg_id) where u.tg_id = p_tg) x);
end $$;
```

Mining settle (call it at the START of collect / buy_character / buy_magic / withdraw / boot reads):
```sql
create or replace function public.settle_mining(p_tg bigint) returns void
language plpgsql security definer set search_path = public as $$
declare u users; s user_state; v_rate_day numeric; v_per_hour numeric; v_hours numeric;
begin
  select * into u from users where tg_id = p_tg for update;
  select * into s from user_state where tg_id = p_tg for update;
  v_per_hour := coalesce((select (value #>> '{}')::numeric from app_settings where key = 'magic_per_hour'), 10);   -- 100 magic = 10 hours
  select coalesce(sum((to_jsonb(c) ->> cc.slug)::numeric * cc.gems_per_day), 0) into v_rate_day
    from characters c, character_config cc where c.tg_id = p_tg;
  v_hours := extract(epoch from (now() - s.last_settle_at)) / 3600;
  if v_rate_day > 0 and u.magic_balance > 0 and v_hours > 0 then       -- mines ONLY while magic exists (and a character is owned)
    v_hours := least(v_hours, u.magic_balance / v_per_hour);           -- stop exactly when magic hits 0
    update user_state set pending_gems = pending_gems + round(v_rate_day / 24 * v_hours, 4) where tg_id = p_tg;
    update users set magic_balance = greatest(0, magic_balance - v_per_hour * v_hours) where tg_id = p_tg;
  end if;
  update user_state set last_settle_at = now() where tg_id = p_tg;     -- no retroactive mining after magic runs out
end $$;
```
`collect_gems(p_tg)`: settle, check `min_collect_gems`, move `pending_gems` into `gems_balance` with `apply_balance`, set pending 0.
`buy_character(p_tg, p_slug, p_qty)`: lock user, settle, check the character is enabled and the slug is in the whitelist, deduct `price_gems * qty` with `apply_balance` (balance can never go below 0), then `execute format('update characters set %I = %I + $1 where tg_id = $2', p_slug, p_slug) using p_qty, p_tg`, ledger row, referrer gets `ref_mage_pct` (10%) of the price into `referral_unclaimed`.
`buy_magic(p_tg, p_pack)`: lock user, settle, read pack from `app_settings.magic_packs` (JSON list `[{"magic":500,"gems":100},{"magic":5000,"gems":1000},{"magic":25000,"gems":5000}]`), deduct gems, add magic, ledger row, referrer gets `ref_magic_pct` (12%).
All buys are idempotent per request key (`p_req`) and rate limited with `rate_hit`.

## 4. Magic and mining rules (customizable)

- **100 magic lasts 10 hours** => `magic_per_hour = 10` (admin setting).
- Mining speed = sum(count x `gems_per_day`) / 24 per hour for all owned characters.
- Mining runs ONLY while `magic_balance > 0`. Magic is used up only while mining. When magic reaches 0 the mining stops and the UI shows "Your characters are resting - they need magic" + Buy magic.
- New user: 500 magic = 50 hours.
- Buying magic after it ran out starts mining from that moment (nothing is paid for the resting time).
- Server time only. Never trust client time. Do not write to the DB every second: store `last_settle_at` and compute live values on read.
- Home screen shows: live pending gems (ticking), "Magic left" amount + hours left (= magic / magic_per_hour), total income per day, COLLECT button.
- Gems can be used to: buy characters, buy magic, withdraw.

## 5. Coin logos (everywhere a coin or chain appears)

Use one reusable `CoinIcon` component (img with lazy load, fixed size, round, fallback = coloured circle with the first letter if the image fails). Show the coin logo, and a small chain logo badge in the corner for multi-chain coins, in ALL of these places:
- Choose-a-coin list/modal (GRAM, USDT, BNB, ETH, USDC)
- Choose-a-chain cards
- Deposit page header, rate card, deposit history "Method" column
- Withdraw method cards (USDT BEP20 / USDT GRAM) and withdraw history
- Admin: Deposits, Withdrawals, Check Deposit, Manual deposit form, Settings coin/chain switches, payout wallet status
Logos: keep the URLs from `assets.ts` (prompt1) but ALSO save copies in `public/coins/` (gram.png, usdt.png, bnb.png, eth.png, usdc.png, chain-bsc.png, chain-eth.png, chain-ton.png) and use the local files first.

```tsx
export function CoinIcon({ symbol, chain, size = 36 }: { symbol: string; chain?: string; size?: number }) {
  const [bad, setBad] = useState(false);
  return (
    <span className="relative inline-block" style={{ width: size, height: size }}>
      {bad ? <span className="flex h-full w-full items-center justify-center rounded-full bg-muted font-bold">{symbol[0]}</span>
           : <img src={`/coins/${symbol.toLowerCase()}.png`} onError={() => setBad(true)} className="h-full w-full rounded-full" alt={symbol} />}
      {chain && <img src={`/coins/chain-${chain}.png`} className="absolute -bottom-1 -right-1 h-1/2 w-1/2 rounded-full ring-2 ring-card" alt={chain} />}
    </span>
  );
}
```

## 6. Secrets (already set in the server env; never hardcode, never log, never send to the browser)

| Env name | What it is |
|---|---|
| `INDEX_SECRET_WALLET` | 12 secret words. Only used to generate per-user deposit addresses from `wallet_index`. |
| `TON_PAY_WALLET_SECRET` | 24 secret words of the TON payout wallet. Use **WalletV5R1 (W5)**. |
| `PAY_BSC_WALLET` | BSC wallet used to pay USDT BEP20 (accept 12/24 words OR a 64-hex private key). |
| `NODEREAL_API` | one NodeReal key, used for BOTH BNB Chain and Ethereum deposit checks. |
| `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TG_ID`, `TON_API_KEY` | as in prompt1 |
| `TON_PAY_ADDRESS` (optional) | expected W5 address; if set, payouts refuse to run when the derived address differs |

Replace `MNEMONIC`, `PAY_WALLET_SECRET`, `TON_WALLET_SECRET`, `ETH_API`, `BSC_API`, `PAY_TON_ADDRESS` from prompt1 with the names above.

## 7. Wallet code

Index -> address (no storage):
```ts
import { HDNodeWallet, Wallet } from "ethers";
let base: HDNodeWallet | null = null;
export function evmAddressFor(index: number): string {
  const words = (process.env["INDEX_SECRET_WALLET"] || "").trim();
  if (words.split(/\s+/).length < 12) throw new Error("INDEX_SECRET_WALLET is not configured");
  base ??= HDNodeWallet.fromPhrase(words, undefined, "m/44'/60'/0'/0");
  return base.deriveChild(index).address;          // user with wallet_index 0 -> child 0, 1 -> child 1 ...
}
```
NodeReal deposit scan: in prompt1 `scanEvm`, use one key for both chains:
```ts
const key = process.env["NODEREAL_API"]; if (!key) return [];
const HOST = { eth: "eth-mainnet", bsc: "bsc-mainnet" } as const;
const url = `https://${HOST[chain]}.nodereal.io/v1/${key}`;     // same nr_getTransactionByAddress call, same rules (incoming only, official contracts only, dedupe by tx_hash+asset)
```
BSC payout wallet (USDT BEP20):
```ts
function bscPayWallet() {
  const v = (process.env["PAY_BSC_WALLET"] || "").trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return new Wallet(v.startsWith("0x") ? v : "0x" + v);
  if (v.split(/\s+/).length >= 12) return HDNodeWallet.fromPhrase(v, undefined, "m/44'/60'/0'/0/0");
  throw new Error("PAY_BSC_WALLET is not configured");
}
// sendUsdtBep20(to, amount) = prompt1 section 14.2 using bscPayWallet(); USDT contract 0x55d398326f99059ff775485246999027b3197955, 18 decimals
```
TON payout wallet, W5:
```ts
import { mnemonicToPrivateKey, getED25519MasterKeyFromSeed, deriveED25519HardenedKey, keyPairFromSeed } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";
import { Address } from "@ton/core";
import { pbkdf2Sync } from "crypto";
export async function tonPayWallet() {
  const words = (process.env["TON_PAY_WALLET_SECRET"] || "").trim().split(/\s+/);
  if (words.length !== 24) throw new Error("TON_PAY_WALLET_SECRET must be 24 words");
  const expected = process.env["TON_PAY_ADDRESS"] ? Address.parse(process.env["TON_PAY_ADDRESS"]) : null;
  const pairs = [await mnemonicToPrivateKey(words)];                       // standard TON wallet words
  let st = await getED25519MasterKeyFromSeed(pbkdf2Sync(words.join(" "), "mnemonic", 2048, 64, "sha512"));
  for (const i of [44, 607, 0]) st = await deriveED25519HardenedKey(st, i);
  pairs.push(keyPairFromSeed(st.key));                                     // BIP39 m/44'/607'/0' variant
  for (const kp of pairs) {
    const w = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey });
    if (!expected || w.address.equals(expected)) return { w, secretKey: kp.secretKey };
  }
  throw new Error("TON payout wallet does not match TON_PAY_ADDRESS");
}
// sendUsdtTon(to, amount) = prompt1 section 14.2 (jetton transfer 0x0f8a7ea5, USDT master EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs, 6 decimals) using tonPayWallet()
```

## 8. Withdraw, deposit, autopay

Keep prompt1 sections 3.3, 3.4, 13, 14, 15 (coin -> chain -> deposit page, native coin goes direct, all on/off switches, withdraw rules, bot buttons, autopay) with the renames from section 2. Withdraw is paid from `gems_balance` (minus `admin_frozen`) at the admin `withdraw_rate_gems_per_usd`. Always call `settle_mining` before reading the balance.

## 9. Admin panel (everything, every value editable, saved in `app_settings` / `character_config`, cache cleared on save)

Tabs: **Dashboard, Users, Withdrawals, Frozen, Deposits, Check Deposit, Broadcast, Autopay, Characters & Magic, Security, Settings, Logs.** All functions from prompt1 section 5 and 17 stay, with these changes:

- **Dashboard**: users, banned, new 24h, pending withdrawals, gems in circulation, magic in circulation, active miners (magic > 0 and owns a character), characters sold per type, deposits / withdrawals / profit (all + today).
- **Users**: search by Telegram id / username; detail shows tg_id, wallet_index, gems, live magic (after settle), pending gems, characters owned (all 9 counts), total deposit / withdraw, referrals, created_at, ban state. Actions: add/remove gems, add/remove magic, give/remove characters, ban/unban, freeze/unfreeze, manual deposit. Suspicious list + bulk ban.
- **Withdrawals / Frozen / Deposits / Check Deposit / Broadcast**: as in prompt1, with CoinIcon logos.
- **Autopay tab** (on/off + values): Auto payment ON/OFF, Auto pay USDT BEP20 ON/OFF, Auto pay USDT GRAM ON/OFF, max auto amount (USD, 0 = never), max paid withdrawals per user (0 = unlimited), min total deposit. Below it a read-only **Payout wallets** card: derived BSC pay address with USDT + BNB balance, derived TON W5 address with USDT + TON balance, red warning when low. Never show any secret words or keys.
- **Characters & Magic tab**: edit each of the 9 characters (display name, price, daily %, gems per day, enabled, image upload), edit magic packs (add/remove, magic amount + gem price), edit `magic_per_hour`.
- **Security tab**: Suspicious accounts, banned devices and IPs (list + unban), rate-limit hits, one-click "pause all withdrawals".
- **Settings tab**, every value editable: `welcome_gems` (1000), `welcome_magic` (500), `magic_per_hour` (10), `deposit_rate_gems_per_usd` (5000), `withdraw_rate_gems_per_usd` (10000), `min_deposit_usd`, `min_withdraw_gems`, `min_collect_gems`, `ref_bonus_gems`, `ref_mage_pct`, `ref_magic_pct`, withdrawal fee type + value, free withdrawal cap, `min_account_age_hours`, `max_new_accounts_per_ip`, deposit switches (`deposits_open`, `auto_deposit`, per coin, per chain), withdraw switches (`withdrawals_open`, BEP20, GRAM), GRAM deposit address + memo prefix, join gate channels, admins, Connect bot button, promo popup text.
- **Logs tab**: `admin_actions` list (who, what, target, reason, time) with search.

## 10. Save in AGENTS.md

- users table has only: id, tg_id, wallet_index, gems_balance, magic_balance, total_deposit, total_withdraw, created_at. Extra fields live in `user_state`.
- wallet_index is sequential from 0 (advisory lock + counter, no gaps). Addresses are never stored; generate from `INDEX_SECRET_WALLET`.
- New user: 1000 gems + 500 magic (admin settings).
- 100 magic = 10 hours (`magic_per_hour` = 10). Mining only while magic > 0; settle on server before every balance action.
- 9 characters: zyron, lunara, aetheris, mystara, vexora, elowyn, dravik, nyxelle, solvyn (counts in `characters`, config in `character_config`).
- Env names: INDEX_SECRET_WALLET, TON_PAY_WALLET_SECRET (W5), PAY_BSC_WALLET, NODEREAL_API (+ optional TON_PAY_ADDRESS).
- Coin logos shown everywhere a coin/chain appears (CoinIcon).
- Next prompt: prompt3.txt.

## 11. Done when

1. First user gets wallet_index 0, second 1, third 2; no address in the DB; each new user starts with 1000 gems and 500 magic.
2. Buying characters/magic with gems works and updates `characters`; mining stops exactly when magic is 0 and 100 magic lasts 10 hours.
3. Deposits (NodeReal + TON memo), withdrawals, autopay on/off and the payout wallet card work; secrets are never exposed.
4. Every coin has its logo in all listed screens; every admin value is editable and applied without redeploy.
5. AGENTS.md and roadmap.md are updated; reply with a short summary and what is still manual.
