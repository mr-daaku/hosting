# OminiLab — Telegram Mini App Store (Build Prompt for Lovable)

Build a complete, production-ready **Telegram Mini App** called **OminiLab** using React + Tailwind on the frontend and Supabase (Postgres + Edge Functions) on the backend.

OminiLab is a digital marketplace that sells **ready-made apps, Telegram bots, automation tools, browser extensions** and similar digital products. **Only the admin can add products.** Users can only browse, favourite and buy. Payment is **crypto only**.

---

## 0. FIRST: read these references before writing any code

1. **UI reference image**: `https://github.com/mr-daaku/hosting/blob/main/OminiLabBot/Screenshot%202026-10-15%20150639.png` (I am also attaching it to this chat). Recreate this design **same to same**: layout, spacing, radius, colours, typography feel, icons, bottom floating nav, cards, chips, buttons. Do not invent a different style.
2. **Deposit-scan logic (port to Edge Functions, keep the same method):**
   - TON/GRAM: `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/ton-scan.js`
   - BSC: `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/bsc-scan.js`
   - ETH: `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/eth-scan.js`
3. **Native coin → USD price method:** `https://github.com/mr-daaku/hosting/blob/main/OminiAiBot/price-ficher.js`

Open and read all four files. Mirror their endpoints, parsing, matching and decimals logic exactly, but rewrite them as **Supabase Edge Functions (Deno/TypeScript)**, since the app cannot run long-lived Node scripts. If a scan file needs any API key or setting, expose that setting in the Admin Panel (section 8). If the contract addresses below differ from the scan files, **the scan files win**.

---

## 1. Platform rules (Telegram only)

- App works **only inside Telegram**. If `window.Telegram.WebApp.initData` is empty, or platform is `unknown`, render a minimal "Open OminiLab inside Telegram" screen and nothing else. No data calls in that state.
- On load call: `Telegram.WebApp.ready()`, `expand()`, **`requestFullscreen()`** (with graceful fallback to `expand()` on old clients), `disableVerticalSwipes()`, and set header/background/bottom bar colours to match the design. Design the whole UI for full-screen mode and respect `safeAreaInset` and `contentSafeAreaInset` (so the status bar/Telegram controls do not overlap content).
- Use Telegram `BackButton` for navigation back, `HapticFeedback` on taps/success/error, and `MainButton` is not needed (use in-app buttons from the design).
- Mobile-first only. Max width container, no desktop layout.

---

## 2. Security (very important)

- **Authentication:** every request goes to an Edge Function that **validates `initData` with HMAC-SHA256** using the bot token (stored as a Supabase secret, never in the client). Check `auth_date` freshness (reject older than 1 hour). On success, issue a short-lived signed session token (JWT, ~1 hour) and use it for later calls.
- **Block bot accounts:** reject if `user.is_bot === true`, if `user` is missing, or if the chat/user data is malformed. Also reject accounts without a valid numeric id. Show a plain "Access denied" screen.
- **Database:** enable **RLS on all tables with no public policies**. The client never touches tables directly. All reads/writes go through Edge Functions using the service role key.
- **Admin:** admin identity is decided server-side only, by a `admins` table of Telegram IDs (seed first admin with Telegram ID `7206619137`). The Admin Panel entry is hidden for non-admins **and** every admin Edge Function re-checks admin status. Never trust a client flag.
- **Secrets:** NodeReal API keys and any other keys are stored server-side only (settings table readable only by service role). Admin UI shows them masked and write-only. **Never store or ask for private keys/mnemonics anywhere.** Use only public receive addresses / xpub if the scan files derive addresses.
- **Rate limiting:** per-user limits on Check Payment (e.g., 1 request / 10 sec, max ~30 / hour), order creation, and login.
- Delivery details are returned **only** to the owner of a paid order. Strict ownership check.
- Sanitize all admin-entered text/HTML. No `dangerouslySetInnerHTML` without sanitising.

---

## 3. Database (keep it tiny, no junk data)

Save only what is needed. No logs, no scan history, no raw blockchain responses.

**`users`** (exactly these columns):
- `userid` (bigint, Telegram id, PK)
- `username` (text, nullable)
- `wallet_index` (integer, unique, auto-increment; used for address derivation if needed; **never store the full address**)
- `joined` (timestamptz)

**Other tables (all separate):**
- `admins` (`userid`)
- `settings` (key/value: deposit addresses, NodeReal keys per chain, TON shared address, payment window minutes, tolerance, etc.)
- `products` (`id` = **5-character string of digits 0–9**, e.g. `00042`; title, category, short description, long description, images array, base price USD, active flag, `buyer_inputs` JSON schema, `delivery` JSON schema, created_at)
- `product_editions` (optional per-product choices like Basic/Pro/Source Code; label + price USD) — shown as the size-style chips from the design
- `orders` (id, userid, product_id, edition, asset, chain, amount_expected (string, exact decimals), usd_value, memo, address_used, status: `pending | paid | expired`, buyer_inputs_data JSON, tx_hash, created_at, expires_at, paid_at)
- `favorites` (userid, product_id)

**Constraints and cleanup:**
- **One purchase per product per user:** unique partial index on `(userid, product_id)` where status = `paid`. Also allow only **one active pending order per user per product** (reuse it if the user presses Buy again).
- `tx_hash` unique, so one transaction can never pay two orders.
- Auto-delete `expired` orders and old `pending` orders after 24h (pg_cron or scheduled Edge Function).
- Add indexes on `orders(userid, status)`, `orders(status, expires_at)`, `favorites(userid)`, `products(active, category)`.

---

## 4. Performance (low DB load, smooth UI)

- **No background polling.** Blockchain is scanned **only when the user taps "Check Payment"** (plus the rate limit above). Optionally, auto-recheck on the payment page every ~30 sec **only while the page is open and the tab is visible**, capped at the payment window.
- Cache the product list and details with React Query (`staleTime` ~5 min), paginate / infinite-scroll the lists (page size ~12), and select only needed columns.
- Cache prices server-side for ~30–60 seconds (in-memory in the Edge Function or a single `settings` row) so many users do not hammer the price API.
- Scan only the **specific address / memo / amount window** of that single order, not whole chains.
- Skeleton loaders, optimistic favourite toggle, image lazy-loading with small thumbnails, no layout shift, smooth 60fps transitions.
- One Edge Function call per screen where possible (batch data).

---

## 5. UI / UX (copy the reference image exactly)

**Style tokens (match the screenshot):** very light grey/white background, white rounded cards, big radius (16–28px), soft shadows, **lime green accent (~#A6D854 / #9ACD32 range)**, **black pill buttons**, grey rounded image tiles, rounded sans-serif font with a friendly geometric feel (e.g., "Urbanist"/"Outfit"), light grey secondary text.

**Home screen:**
- Top row: round white menu button (left) and round white button (right, opens Orders). No fake status bar in the real app (that is only in the mockup).
- Rounded search bar "What are you looking for?" with filter icon on the right (filter by category/price/sort).
- Green promo banner with "Limited Offer" black chip, headline, black "Shop Now ↗" pill, and an illustration on the right + carousel dots. Banners are **admin-managed** (title, text, image, link to product/category).
- **Categories** row (title "Categories" + green "See all"): chips with image on the right — **Apps, Telegram Bots, Automation, Extensions** (admin can add or remove categories).
- **New Arrival** section ("See all" in green): 2-column grid of product cards with grey image tile, heart button, name and price below.
- Floating white **pill bottom navigation** exactly like the design: active tab = green circular icon + label in a light-green pill. Tabs: **Home, Orders** (replaces cart icon), **Favourites** (heart), **Profile**.

**Product Details screen:**
- Header: round back button, centered title "Details", round button on the right.
- Large grey rounded image tile with swipeable gallery and dots.
- Small grey category label, bold product title, heart button on the right.
- Store row: logo, **"OminiLab"** with verified tick, "Official store", and black rounded pill (use it as "Official" badge instead of Follow).
- "Select edition" chips (like the S/M/L/XL chips; selected chip is lime green) — shown only if the product has editions.
- **Quantity is fixed to 1** (show it disabled, or hide). A product can be bought only once per user.
- Description (expandable).
- Bottom floating bar: "Total price" + amount, and a green **"Buy Now"** pill button (replaces Add to Cart). If already purchased, show "View Details" instead.

**Orders screen:** list of the user's orders with status chip (Pending / Paid / Expired). Paid orders open the delivered details. **Profile screen:** avatar, name, username, joined date, purchased count. Keep it simple.

---

## 6. Purchase flow (strict order)

1. **User taps Buy Now.** Server verifies the product is active and the user has not already bought it. If already bought, block it.
2. **Select payment method:** USDT, USDC, BNB, GRAM, ETH.
3. **Select chain** (only for stablecoins):
   - USDT → BSC, ETH, TON
   - USDC → BSC, ETH
   - BNB → BSC (automatic, no chain screen)
   - ETH → ETH (automatic, no chain screen)
   - GRAM → TON (automatic, no chain screen)
   Do **not** show the chain screen for native coins.
4. **Payment page** shows:
   - **QR code**, exact **amount** to send, **address** (copy button), network name and a countdown timer (payment window set in admin, default 30 min).
   - **Memo/comment only for GRAM and USDT on TON** (because these use one shared address, set by admin). Memo format: `OLB-{productId}-{userId}` where productId is the 5-digit id (e.g., `OLB-00042-7206619137`). Show a prominent "Memo is required" warning with a copy button.
   - For BSC/ETH assets, follow how the scan files derive/receive addresses (per-user via `wallet_index`, or the admin-set address). Never store the full address in `users`.
   - **Native coins (ETH, BNB, GRAM):** convert the product's USD price into native coin amount **live** using the logic from `price-ficher.js`, show both the USD value and the native amount, and **lock that quote in the order** for the payment window. **Stablecoins (USDT/USDC) are NOT converted** — 1 USD = 1 token.
   - A "Check Payment" button.
5. **Check Payment:** Edge Function scans using the ported scan logic (NodeReal API for BSC/ETH with the admin-set key; ton-scan logic for TON). Match by address/memo + amount (with admin-set small tolerance) + time window + token contract. Mark `paid` atomically and store `tx_hash`. Prevent double-use of the same tx.
6. **Payment received:** success animation + haptic.
7. **Send details:** show the product's delivery details (section 7) inside the app, and also send them via a Telegram bot message to the user (use the bot token in the Edge Function). Order also remains accessible in Orders.

**Token contracts (verify against the scan files):**
- BSC USDT `0x55d398326f99059fF775485246999027B3197955` (18 dec), BSC USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 dec)
- ETH USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` (6 dec), ETH USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6 dec)
- TON USDT jetton master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`

---

## 7. Admin-defined product options (dynamic form builder)

When creating/editing a product, the admin gets a **flexible option builder** where they can add any number of fields in any order, drag to reorder, and mark each required/optional. Two builders:

**A) Buyer inputs (what the admin needs to collect from the buyer after payment, e.g., bot token, domain, Telegram username, preferred name, notes):**
field types: short text, long text, number, URL, email, dropdown, multi-select, checkbox/toggle, date, file upload (small files only), image upload. Each has label, placeholder, help text, validation (regex/min/max).

**B) Delivery details (what the buyer receives after payment):**
content blocks: text, rich note, copyable secret (license key / login / password with a copy button and "reveal" toggle), download link, button link, file/image, video link, step-by-step instructions, and "support contact". Each block can be marked secret (hidden until revealed).

Flow: if the product has buyer inputs, after payment is confirmed the buyer fills the form first, then the delivery details are shown. Store only the submitted answers in `orders.buyer_inputs_data` (JSON). Notify admin on a new paid order (Telegram message to admins, including product and the buyer's submitted inputs).

Also allow: multiple images, editions with different prices, category assignment, active/hidden toggle, and "featured / New arrival" toggle.

---

## 8. Admin Panel (inside the same Mini App, admin only)

Sections:
- **Products:** create / edit / hide / delete, with the option builders above.
- **Categories & banners:** manage home categories and promo carousel.
- **Orders:** list with filters (pending/paid/expired), view buyer inputs, mark delivery re-sent, and manual "mark as paid" with confirmation.
- **Payment settings:**
  - **NodeReal API key(s)** for BSC and ETH scanning (write-only, masked after saving).
  - **TON shared receive address** (used by GRAM and USDT-TON with memo).
  - EVM receive address / derivation settings as required by the scan files.
  - Payment window (minutes), amount tolerance, check-payment rate limit.
  - Any other key the scan files or price-ficher need.
- **Users:** simple count and search by id/username (read-only).
- **Admins:** add/remove admin Telegram IDs.

---

## 9. Quality bar

- TypeScript throughout, clean folder structure, reusable components, all text in English.
- Handle every error state: network failure, expired order, underpaid / overpaid, wrong memo, duplicate tx, user already purchased, product disabled mid-checkout.
- Underpayment: show "received X, remaining Y". Do not mark as paid.
- No console secrets, no hard-coded keys, environment variables / Supabase secrets only.
- Test the whole flow end-to-end and make sure the app runs correctly inside Telegram's WebView in fullscreen.

Start by reading the 4 reference files and the UI image, then confirm the plan in 8–10 bullet points, then build everything.

admin id - 7206619137
And any other API, the admin will set everything in the admin panel, and add a /start command reply system to the bot. Also, check from initdata whether it's in the Telegram bot mini app or not, and for that, a BOT_TOKEN is needed, so I have saved the bot token in secret as BOT_TOKEN.
