# CLOUDFLARE (frontend) + LOVABLE CLOUD (backend + database) — "missing key" kabhi nahi

> **Goal:** Frontend kahin bhi host ho (Cloudflare Pages / koi bhi static host), **backend (edge functions) aur database hamesha Lovable Cloud pe**. Frontend ko koi secret/env chahiye hi nahi, isliye "missing key / env not set" jaisa error user ko kabhi nahi dikhta.
>
> **Lovable ko bolo:** "claudflare_lovable.md ke hisaab se frontend ko zero-env banao (section 3), gateway function ko JWT-off + initData auth pe rakho (section 4), CORS allowlist lagao (section 5), `/api/health` aur admin Config Health banao (section 7). Backend/DB Lovable Cloud pe hi rahe, kuch bhi Cloudflare pe shift mat karo."

---

## 1. Kya kahan rehta hai

| Cheez | Kahan | Cloudflare me chahiye? |
|---|---|---|
| React app (static files) | **Cloudflare Pages** (ya koi static host) | haan (sirf hosting) |
| Edge functions (`api`, `admin-api`, `bot-webhook`, workers) | **Lovable Cloud** | nahi |
| Database (Postgres) | **Lovable Cloud** | nahi |
| Secrets (BOT_TOKEN, TonCenter/TonAPI/NodeReal keys, mnemonics, ADMIN_ID...) | **Lovable Cloud → Secrets** | **nahi, kabhi nahi** |
| Cron/Jobs (scanner, payout worker) | **Lovable Jobs** (Cloud) | nahi |
| Storage (images) | Lovable Cloud storage | nahi |
| Domain/DNS/CDN/WAF | Cloudflare | haan |

```
Telegram user ──► https://app.yourdomain.com  (Cloudflare Pages: sirf static JS/CSS)
                        │ fetch (HTTPS, headers: x-tg-init-data, x-device-fp)
                        ▼
          Lovable Cloud edge function `api`  ──► Lovable Cloud Postgres
                        ▲
Telegram webhook ───────┘ (`bot-webhook`, secret_token se protected)
```

Backend Lovable pe hai, isliye **saari keys Lovable ke andar hain**. Frontend ko keys ki zarurat nahi → "missing key" ka sawaal hi khatam.

---

## 2. Setup steps

1. Lovable project (Cloud on) me app banao. Backend functions + DB Lovable khud manage karta hai.
2. Lovable → **GitHub sync on** (two-way). Repo ban jata hai.
3. Cloudflare → Pages → Connect to Git → wahi repo.
   - Build command: `npm run build`
   - Output directory: `dist`
   - **Environment variables: kuch nahi daalna** (zero-env design).
4. SPA refresh 404 fix: `public/_redirects` →
   ```
   /* /index.html 200
   ```
5. Security + cache headers `public/_headers`:
   ```
   /*
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
     Content-Security-Policy: frame-ancestors https://web.telegram.org https://*.telegram.org
   /assets/*
     Cache-Control: public, max-age=31536000, immutable
   ```
   > `frame-ancestors` Telegram ke liye hai; agar Telegram desktop/web me app load na ho to is line ko loose karo (builder test kare).
6. Custom domain Cloudflare Pages me attach karo.
7. BotFather: Mini App / Menu button URL = Cloudflare domain.
8. Telegram webhook URL = **Lovable Cloud function URL** (`bot-webhook`), `secret_token` ke saath (CORE_METHODS.md M9). Frontend domain badalne se webhook nahi tutta.

Deploy flow: Lovable me prompt → code GitHub pe push → Cloudflare auto-build → frontend live. Backend functions Lovable khud deploy karta hai (har build ke baad deploy confirm karna prompt me likho).

---

## 3. Frontend zero-env design (missing key nahi aayegi)

Frontend ko sirf ek **public** value chahiye: backend ka base URL. Ye secret nahi hai, isliye code me hardcode (commit) karna safe hai. Anon/publishable key ki bhi zarurat nahi (section 4).

```ts
// src/config.ts  — Lovable apna backend URL yaha khud likh de (Lovable ko apna URL pata hai)
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ||          // optional override
  "https://{LOVABLE_BACKEND_REF}.supabase.co/functions/v1";                 // default: hardcoded, hamesha present

export const BOT_USERNAME = "{BOT_USERNAME}";
export const MINIAPP_SHORTNAME = "{SHORTNAME}";
```
Rules:
1. Build ya runtime me koi env missing ho to bhi app chalna chahiye (default constants).
2. Frontend me `if (!import.meta.env.X) throw ...` ya "Missing Supabase key" jaisa code **nahi**.
3. Sirf `fetch` use karo (supabase-js client ki zarurat nahi); isse anon key chahiye hi nahi.
4. Koi bhi secret (`BOT_TOKEN`, `MNEMONIC`, `SERVICE_ROLE`, provider API keys) frontend me nahi: `grep -R "BOT_TOKEN\|MNEMONIC\|SERVICE" dist/` empty hona chahiye.

API client (ek hi jagah):
```ts
// src/lib/api.ts
export class ApiError extends Error { constructor(public status: number, public code: string, public retryAfter?: number) { super(code); } }

export async function api<T>(action: string, body: object = {}, opts: { admin?: boolean } = {}): Promise<T> {
  const tg = (window as any).Telegram?.WebApp;
  const res = await fetch(`${API_BASE}/${opts.admin ? "admin-api" : "api"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tg-init-data": tg?.initData ?? "",
      "x-device-fp": await getFingerprint(),
      "x-idem-key": crypto.randomUUID(),
      ...(opts.admin ? { "x-admin-token": sessionStorage.getItem("adm") ?? "" } : {}),
    },
    body: JSON.stringify({ action, ...body }),
  }).catch(() => { throw new ApiError(0, "network"); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new ApiError(res.status, j.code ?? "server", Number(res.headers.get("retry-after")) || undefined);
  return j.data as T;
}
```

### 3.1 Error message policy (user ko kya dikhega)

| Situation | User ko message | Kahan detail |
|---|---|---|
| Network/5xx/unknown | "Something went wrong. Retry" + Retry button | server log |
| 429 | "Too many requests. Try in {n}s" | — |
| 401 (Telegram ke bahar) | "Please open this app from Telegram" | — |
| 403 banned | "Account restricted" | — |
| **Server me koi secret missing** | **Generic "Service is busy, try again" — kabhi key/env ka naam nahi** | **sirf admin Config Health + server log** |

Kisi bhi response/UI/toast me env var name, "missing key", "API key not set", stack trace nahi jaana chahiye. Server side error mapper:
```ts
// _shared/errors.ts
export function publicError(e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  console.error("[server]", msg);                                         // log me full detail
  if (/missing|not set|api[_ ]?key|secret|env/i.test(msg)) { recordConfigIssue(msg); return { status: 503, code: "service_busy" }; }
  if (e instanceof HttpError) return { status: e.status, code: e.code };
  return { status: 500, code: "server" };
}
```
`recordConfigIssue` sirf admin ke Config Health ke liye note karta hai (names only).

---

## 4. Gateway function: JWT off, auth = Telegram initData

Frontend ke paas Supabase JWT/anon key nahi hota, isliye gateway functions ko **JWT verification OFF** rakho. Security JWT se nahi, in layers se aati hai:

1. Telegram `initData` HMAC verify (bot token Lovable secret me) — CORE_METHODS.md M2.
2. Device fingerprint mandatory, ban check.
3. Rate limit (Cloudflare WAF + app-level Redis).
4. DB pe RLS deny-all; function service-role se kaam karta hai.
5. `bot-webhook`: `secret_token` header.
6. `admin-api`: `ADMIN_ID` + PIN token.

```toml
# supabase/config.toml  (Lovable ko bolo: functions ke liye verify_jwt=false lagaye)
[functions.api]
verify_jwt = false
[functions.admin-api]
verify_jwt = false
[functions.bot-webhook]
verify_jwt = false
# scanner/payout/job workers: cron secret header se protected (verify_jwt=false + x-cron-secret check)
```
> Builder note: Lovable Cloud me `verify_jwt` config apply hua ya nahi, deploy ke baad ek unauthenticated `curl` se check karo ("401 from our code" aana chahiye, platform JWT error nahi).

Workers/cron functions (`deposit-scanner`, `payout-worker`, `job-worker`): Lovable Jobs unko internally call karte hain; bahar se call na ho sake isliye `x-cron-secret` check (secret Lovable Cloud me hi).

---

## 5. CORS (frontend domain ko allow)

Frontend alag domain pe hai, isliye edge functions me allowlist:

```ts
// _shared/cors.ts
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://app.yourdomain.com,https://your-project.pages.dev").split(",");
export function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  const ok = ALLOWED.includes(o) || /^https:\/\/[a-z0-9-]+\.lovable\.app$/.test(o);     // Lovable preview
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED[0],
    "Access-Control-Allow-Headers": "content-type, x-tg-init-data, x-device-fp, x-idem-key, x-admin-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
// har function me: if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
```
`ALLOWED_ORIGINS` Lovable Cloud secret/config me (default value code me bhi hai, isliye missing nahi hoga). Naya domain add karte waqt yahi list update karo.

---

## 6. Optional: Cloudflare same-origin proxy (`/api/*`)

Fayde: CORS nahi, backend URL chhupa, Cloudflare ke edge pe GET caching (leaderboard/settings), WAF/rate-limit ek jagah. **Is proxy ko koi secret nahi chahiye** (kyunki function JWT-off hai), isliye zero-env rehta hai.

```ts
// functions/api/[[path]].ts   (Cloudflare Pages Function)
const BACKEND = "https://{LOVABLE_BACKEND_REF}.supabase.co/functions/v1";      // hardcoded public URL

export const onRequest: PagesFunction = async ({ request, params }) => {
  const path = ([] as string[]).concat(params.path as string[] ?? []).join("/");   // api | admin-api
  if (!["api", "admin-api"].includes(path)) return new Response("not found", { status: 404 });
  const url = `${BACKEND}/${path}`;
  const res = await fetch(url, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
};
```
Frontend tab `API_BASE = "/api-proxy"`-style same-origin use karta hai (route naming apne hisaab se). Agar proxy me kuch fail ho (Cloudflare function limits), app direct `API_BASE` pe fallback kare: `try proxy → catch → direct`.

---

## 7. Health + Config Health (missing keys sirf admin ko)

`GET /api/health` (public, minimal): `{ ok: true, time }` — koi detail nahi.

Admin Config Health (admin-api `config_health`): Lovable Cloud ke andar ye check chalta hai aur sirf admin ko dikhata hai:

```ts
const REQUIRED = ["BOT_TOKEN","WEBHOOK_SECRET","ADMIN_ID","ADMIN_PIN_HASH","ADMIN_TOKEN_SECRET","TONCENTER_API_KEY","TONAPI_KEY","BSC_API","ETH_API","HD_MNEMONIC","PAYOUT_EVM_MNEMONIC","PAYOUT_TON_MNEMONIC","UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN"];
export const configHealth = () => REQUIRED.map(k => ({ key: k, set: !!Deno.env.get(k) }));      // value kabhi nahi
```
Admin panel → "Logs & Health → Config health": green (set) / red (missing). Missing secret ho to related feature **gracefully band** (e.g. deposit scanner "paused: provider key missing") aur user ko "processing / temporarily unavailable" dikhe, error nahi.

Feature-flag pattern: har module start par apni required keys check karta hai; missing ho to `safe_mode` module-level, baaki app chalta rahe.

---

## 8. Cron/Jobs (backend Lovable pe)

- Scanner (30s), payout worker (10s), job worker (10s), retention cleanup (daily) — **Lovable Jobs** se banao (chat me: "create a scheduled job that calls deposit-scanner every 30 seconds").
- Agar Lovable Jobs ki frequency kam pade to external scheduler (Crontap jaisa) function ko `x-cron-secret` ke saath call kare. **Cloudflare Cron Trigger** bhi chalega, lekin tab us Worker me `x-cron-secret` rakhna padega (ye ek mātra exception hai; isse bachna ho to Lovable Jobs use karo).
- Jobs ke runs ka status Admin → Logs & Health me.

---

## 9. Scale notes (Lovable backend ke saath)

- Frontend Cloudflare CDN pe → kitne bhi users, static load ka tension nahi.
- Backend limit = Lovable Cloud ka database/function capacity. Zarurat pade to Lovable chat se **instance size upgrade** (Pro plan) karo; saath me M6/M7 (cache, bootstrap RPC, counters, queue) lagu rakho taaki DB par load kam rahe.
- Realtime sirf jaha zaruri; polling smart (focus + backoff).
- Lovable Cloud ek baar on = permanent aur DB ka seedha SQL-level cron access nahi; isliye scheduled kaam Lovable Jobs/edge functions se (section 8).

---

## 10. Troubleshooting

| Dikkat | Wajah | Fix |
|---|---|---|
| Page refresh pe 404 | SPA redirect nahi | `_redirects` file |
| CORS error | Domain allowlist me nahi | `ALLOWED_ORIGINS` update |
| 401 "open from Telegram" browser me | Normal (initData nahi) | Sirf Telegram me kholo; browser me loader |
| 401 Telegram ke andar bhi | Galat bot token secret ya initData expire | `BOT_TOKEN` check (admin Config Health), app dobara kholo |
| Platform "JWT" error | `verify_jwt` off apply nahi hua | config.toml + redeploy |
| Webhook update nahi aa raha | Webhook URL purana / secret mismatch | Admin → Webhook info → re-set |
| Naya domain pe white screen | Build me asset path | Cloudflare Pages build log, `base` path check |
| User ko "missing key" dikha | Error mapper nahi laga | Section 3.1 `publicError` har function me |

## 11. Final checklist

- [ ] Cloudflare Pages me **koi env var nahi** aur app phir bhi chalta hai
- [ ] `dist/` me koi secret nahi (`grep`)
- [ ] Browser me app band (loader), Telegram me open
- [ ] Unauthenticated `curl` function pe 401 (hamare code se)
- [ ] CORS: allowed domain OK, random origin blocked
- [ ] Secret jaan-bujh ke hata ke test: user ko friendly "busy" message, admin Config Health me red item, app crash nahi
- [ ] Webhook Lovable function URL pe, `secret_token` ke saath
- [ ] Scanner/payout/job workers Lovable Jobs se chal rahe
- [ ] GitHub push → Cloudflare auto-build → live
