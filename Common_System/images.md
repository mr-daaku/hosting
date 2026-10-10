# IMAGES — coin, chain, token aur chain-coin ke images (har bot me same)

> **Lovable ko bolo:** "App me jaha bhi coin/chain/token dikhe wahan is file ka resolver aur `<CoinIcon>` component use karo. Images hotlink nahi, pehle apni storage me mirror karo. Fallback SVG zaroor lagao."
>
> **Honest note:** niche ke URLs official **Trust Wallet assets repo** ke documented pattern par bane hain (pattern check kiya hai). Har ek file ka exists hona main yaha live test nahi kar paya, isliye section 7 ka **verify + mirror script** ek baar chalao; jo fail ho wo resolver fallback se aa jayega.

---

## 1. Rules

1. **Source of truth = DB table `asset_images`** (admin se override ho sakta). URL hardcode components me nahi.
2. Resolver order: **(1) admin override → (2) Trust Wallet repo → (3) provider metadata (TonAPI / Dexscreener / CoinGecko) → (4) generated SVG (letter avatar)**.
3. Pehli baar mil jaye to image **apni storage me mirror** karo (Supabase Storage / Lovable Cloud storage ya Cloudflare R2) aur wahi URL use karo. Isse: speed, hotlink-block se bachav, third-party down hone par bhi image.
4. Size: coin icons 128×128 WebP (UI me 24/32/40 px), chain badge 64×64. `loading="lazy"`, explicit `width/height`, `decoding="async"`.
5. Cache header 1 saal (immutable, file name me version/hash).
6. Fake token ka image kabhi trust nahi: image sirf **whitelisted contract address** ke liye resolve hoti hai.
7. Emoji icon nahi (kuch apps me "no emoji, SVG only" rule hai): fallback bhi SVG.

---

## 2. Base URLs

| Source | Base URL | Kaam |
|---|---|---|
| Trust Wallet (coin/chain) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/{chain}/info/logo.png` | Chain/native coin logo |
| Trust Wallet (token) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/{chain}/assets/{contract}/logo.png` | Token logo. EVM me contract **checksum** form |
| TonAPI jetton metadata | `https://tonapi.io/v2/jettons/{jetton_master}` → `metadata.image` | TON jettons (NOT, DOGS, TAKE, KETTON, USDT) |
| Dexscreener token | `https://api.dexscreener.com/latest/dex/tokens/{address}` → `pairs[0].info.imageUrl` | Koi bhi chain ka token (Solana xStocks, naye tokens) |
| CoinGecko coin | `https://api.coingecko.com/api/v3/coins/{id}` → `image.large` | Major coins (id: bitcoin, ethereum, binancecoin, tron, solana, the-open-network, tether, usd-coin, notcoin) |

Trust Wallet chain folder names: `bitcoin`, `ethereum`, `smartchain` (BNB Smart Chain), `tron`, `solana`, `arbitrum`, `base`, `polygon`, `ton`.

---

## 3. Chains (network badge)

| Key | Label (UI) | Logo URL |
|---|---|---|
| `btc` | Bitcoin | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png` |
| `eth` | Ethereum (ERC20) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png` |
| `bsc` | BNB Smart Chain (BEP20) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png` |
| `trx` | Tron (TRC20) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/tron/info/logo.png` |
| `sol` | Solana | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png` |
| `ton` | TON (label GRAM ho sakta) | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ton/info/logo.png` *(folder verify karo; na mile to TonAPI/CoinGecko `the-open-network`)* |
| `arb` | Arbitrum | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png` |
| `base` | Base | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png` |

## 4. Native coins

| Coin | Chain | Logo (same as chain logo) |
|---|---|---|
| BTC | btc | bitcoin/info/logo.png |
| ETH | eth | ethereum/info/logo.png |
| BNB | bsc | smartchain/info/logo.png |
| TRX | trx | tron/info/logo.png |
| SOL | sol | solana/info/logo.png |
| TON / GRAM | ton | ton/info/logo.png (GRAM naam ho to **admin override image** table me, label alag) |

## 5. Stablecoins aur tokens (contract-based)

**Contract addresses official explorer/issuer docs se verify karke hi enable karo** (images isi address pe depend karti hain).

| Token | Chain | Contract | Logo URL |
|---|---|---|---|
| USDT | eth | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | `…/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png` |
| USDC | eth | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `…/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png` |
| USDT | bsc | `0x55d398326f99059fF775485246999027B3197955` | `…/blockchains/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png` |
| USDC | bsc | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | `…/blockchains/smartchain/assets/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d/logo.png` |
| USDT | trx | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `…/blockchains/tron/assets/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/logo.png` |
| USDC | sol | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `…/blockchains/solana/assets/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png` |
| USDT | sol | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `…/blockchains/solana/assets/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png` |
| USDT | ton | jetton master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` | TonAPI `…/v2/jettons/{master}` → `metadata.image` (ya USDT ka Ethereum logo reuse) |

`…` = `https://raw.githubusercontent.com/trustwallet/assets/master`

### 5.1 Chain-specific tokens (xStris jaise menu)

| Group | Tokens | Method |
|---|---|---|
| GRAM Token (TON jettons) | DOGS, TAKE, KETTON, NOT | Admin listing wizard me jetton master address aata hai → TonAPI `jettons/{master}` se `metadata.image` → mirror |
| SOL Token | TRUMP, GOOGLX, NVDAX (xStocks) | Mint address → Dexscreener `info.imageUrl` (ya Trust Wallet solana/assets/{mint}) → mirror |
| EVM tokens | koi bhi | Trust Wallet checksum URL → na mile to Dexscreener → CoinGecko → SVG fallback |

Token addresses code me hardcode nahi; `assets.address_raw` se aate hain (listing wizard me contract mandatory).

---

## 6. Chain-coin badge (coin + chain ek saath)

Look: bada coin icon, neeche-right me chhota chain logo (white ring ke saath). Jaise USDT + BEP20, USDT + TRC20.

```
┌────────┐
│  USDT  │●BNB    (coin 40px, chain badge 18px, border 2px background-color)
└────────┘
```

```tsx
// components/CoinIcon.tsx
type Props = { symbol: string; chain?: string; size?: number; showChain?: boolean };

export function CoinIcon({ symbol, chain, size = 40, showChain = true }: Props) {
  const coin = useAssetImage(symbol, chain);          // resolver (section 8), cached
  const net  = useChainImage(chain);
  const badge = Math.round(size * 0.45);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <SmartImg src={coin} alt={symbol} size={size} fallbackText={symbol} className="rounded-full" />
      {showChain && chain && !isNative(symbol, chain) && (
        <SmartImg src={net} alt={chain} size={badge} fallbackText={chain}
          className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[var(--bg)]" />
      )}
    </span>
  );
}

function SmartImg({ src, alt, size, fallbackText, className = "" }: any) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <LetterSvg text={fallbackText} size={size} className={className} />;
  return <img src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async"
              onError={() => setBad(true)} className={className} style={{ width: size, height: size, objectFit: "cover" }} />;
}

// emoji nahi, SVG letter avatar (deterministic color)
function LetterSvg({ text, size, className }: { text: string; size: number; className?: string }) {
  const t = (text || "?").slice(0, 2).toUpperCase();
  const hue = [...t].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} role="img" aria-label={text}>
      <circle cx="20" cy="20" r="20" fill={`hsl(${hue} 55% 45%)`} />
      <text x="20" y="25" textAnchor="middle" fontSize="15" fontWeight="700" fill="#fff" fontFamily="system-ui,sans-serif">{t}</text>
    </svg>
  );
}
```
Usage: `<CoinIcon symbol="USDT" chain="bsc" />` (deposit chain list), `<CoinIcon symbol="BNB" chain="bsc" />` (native: badge nahi), withdraw list, balance cards, history rows, admin tables.

Chain selection screen me chain ka **bada logo + label** (`ChainIcon`), coin selection me coin icon, final deposit page par **chain-coin badge** + QR.

---

## 7. DB + mirror + verify

```sql
create table asset_images (
  key text primary key,            -- 'coin:USDT:bsc' | 'coin:BNB:bsc' | 'chain:bsc' | 'coin:DOGS:ton'
  url text not null,               -- mirror kiya hua apna URL
  source text,                     -- override | trustwallet | tonapi | dexscreener | coingecko
  checked_at timestamptz default now()
);
```

**Mirror + verify script** (Lovable ek baar chalaye, phir naye asset par automatically):

```ts
// _shared/images.ts
const TW = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";
const TWDIR: Record<string, string> = { eth: "ethereum", bsc: "smartchain", trx: "tron", sol: "solana", arb: "arbitrum", base: "base", btc: "bitcoin", ton: "ton" };

export async function resolveImageUrl(a: { symbol: string; chain: string; address?: string | null; kind: "native" | "token" }): Promise<{ url: string; source: string } | null> {
  const tryUrl = async (u: string) => { try { const r = await fetch(u, { method: "GET" }); return r.ok && (r.headers.get("content-type") ?? "").startsWith("image") ? u : null; } catch { return null; } };

  // 1) Trust Wallet
  const dir = TWDIR[a.chain];
  if (dir) {
    const u = a.kind === "native" ? `${TW}/${dir}/info/logo.png` : a.address ? `${TW}/${dir}/assets/${a.address}/logo.png` : null;
    if (u && await tryUrl(u)) return { url: u, source: "trustwallet" };
  }
  // 2) TON jetton
  if (a.chain === "ton" && a.address) {
    const j = await fetch(`https://tonapi.io/v2/jettons/${a.address}`, { headers: { Authorization: `Bearer ${Deno.env.get("TONAPI_KEY")}` } }).then(r => r.json()).catch(() => null);
    const u = j?.metadata?.image; if (u && await tryUrl(u)) return { url: u, source: "tonapi" };
  }
  // 3) Dexscreener (any chain, by token address)
  if (a.address) {
    const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${a.address}`).then(r => r.json()).catch(() => null);
    const u = d?.pairs?.[0]?.info?.imageUrl; if (u && await tryUrl(u)) return { url: u, source: "dexscreener" };
  }
  return null;                                  // → SVG fallback
}

export async function mirror(key: string, src: { url: string; source: string }) {
  const bytes = new Uint8Array(await (await fetch(src.url)).arrayBuffer());
  const path = `coins/${key.replace(/[^a-z0-9_-]/gi, "_")}.png`;
  await storage.from("assets").upload(path, bytes, { contentType: "image/png", upsert: true, cacheControl: "31536000" });
  const url = storage.from("assets").getPublicUrl(path).data.publicUrl;
  await db.from("asset_images").upsert({ key, url, source: src.source, checked_at: new Date().toISOString() });
  return url;
}
```
Lovable ko batao: Storage bucket `assets` **public read** banao (images ke liye safe), write sirf backend.

---

## 8. Frontend resolver (fast)

- App open par ek call: `GET /api/asset-images` → `{ "coin:USDT:bsc": url, "chain:bsc": url, ... }` (cached 1 ghanta Redis + client `staleTime: 1h`). 100 icons ka map chhota hai.
- `useAssetImage(symbol, chain)` map se URL deta hai; map me na ho to `null` → SVG fallback, aur background me backend ko "resolve this" hint (rate-limited).
- Critical icons (USDT, BNB, TON, ETH) `<link rel="preload" as="image">`.
- Bottom nav/menu icons alag (SVG, app ke apne).

## 9. Admin

- Assets tab me har asset ka logo preview + **Replace image** (upload PNG/WebP/SVG ≤ 200 KB) + "Re-fetch from source".
- Naya asset list hone par resolver auto chalta hai; image na mile to admin ko warning badge ("image missing, SVG fallback use ho raha hai").
- Fake-lookalike guard: naya token ka image existing known token (USDT) se same ho to warning.

## 10. Quick checklist

- [ ] Har coin/chain/token jaha dikhe `CoinIcon`/`ChainIcon` use hota hai
- [ ] Mirror script chala, `asset_images` bhara, fail items ki list admin ko dikhi
- [ ] Image load fail ho to SVG letter fallback (blank box nahi)
- [ ] Koi third-party hotlink runtime me nahi (mirror URL hi)
- [ ] Icons lazy + width/height (layout shift nahi)
- [ ] GRAM/TON label override image setting kaam karti
