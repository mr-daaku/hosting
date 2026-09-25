# OminiAi — Update Prompt 4 (UI polish, live rates, i18n, branding)

Follow-up change list on top of `prompt.md` and `prompt2.md`. Implement all of the below completely.

---

## 1. Home Page — Claim Profit / How to Earn Buttons

- Currently these render as two separate full-width buttons stacked/side-by-side, and they overflow past the left/right edges of the screen on some devices.
- Change to a **single compact row**, both actions inline, separated by a thin vertical divider — visually like:

  ```
  Claim   |   How to earn
  ```

  Not two separate big buttons — one pill/row containing both tap targets, sized to always fit within the screen width with safe margins on both sides (no horizontal overflow on any device width).
- **Minimum claimable profit: $0.01.** If the user's accrued profit is below $0.01, disable the Claim action (or show it greyed out) until it crosses that threshold. This minimum must be admin-editable in Settings alongside the other economy constants.

---

## 2. Fullscreen Top-Offset — Reduce

The earlier safe-area top-padding fix (from `prompt2.md` §1) overcorrected — content now sits noticeably too low in fullscreen mode. Reduce the top offset: if content currently sits at roughly **100%** of the previous "too high" gap, bring it back up by about **40%** (i.e. roughly 60% of the current top padding/offset value), then verify it against the actual device status-bar/notch height using Telegram's safe-area values rather than a fixed guess, so it isn't a hardcoded magic number that only happens to work on one device.

---

## 3. Deposit Page — Live Rate Not Fetching

On the deposit page, the line **"1 [native coin] = … USDT = … coins"** currently shows only placeholder text (`…`) instead of the real live values — the price fetch isn't wired up / isn't returning data. Fix this so it always shows real numbers:

- Actually call the live price source (e.g. CoinGecko public API) for the selected native coin, convert to USDT, then to coins (100x rule), and render the real numbers in place of the placeholders.
- Handle the loading state (brief spinner/skeleton while the price call is in flight) and a fallback if the price API fails (retry, or show last-known cached price with a "last updated" note — never leave it stuck on `…`).

### Caching
Wherever it reduces load on the database or repeated external API calls, add caching:
- Cache live price lookups for a short TTL (e.g. 30–60 seconds) so multiple users/pages don't all trigger a fresh external API call — serve from cache within that window.
- Cache other frequently-read, rarely-changing data (e.g. `app_settings`) in memory/edge cache with sensible invalidation on admin updates, instead of hitting the database on every request.

---

## 4. Multi-Language Support (i18n)

Add multi-language support across the app:
- **English (`en`)** — default
- **Russian (`ru`)**
- **Chinese (`zh`)**
- **Arabic (`ar`)**
- (leave the i18n structure open to easily add more languages later)

Implement with a standard i18n library (e.g. `react-i18next` or `next-intl` equivalent for this stack), all user-facing strings externalized into per-language translation files, with a language switcher (the Account page already has a Language setting from `prompt2.md` §2 — wire it up to actually change the app language, not just display a static "English" label). Right-to-left layout must work correctly for Arabic.

---

## 5. App Logo

Ask Lovable to generate a proper app logo/icon for OminiAi (used as the Mini App icon, loading screen, and anywhere the app's own brand mark is shown) — distinct from the per-coin logos already specified in `prompt.md` §2.

---

## 6. Hide Lovable Badge

Add this to the project's global stylesheet (`style.css` or equivalent global CSS):

```css
#lovable-badge {
  display: none !important;
}
```

---

## Summary

Do all of this in one pass: compact Claim/How-to-earn row with $0.01 minimum claim (§1), reduced fullscreen top offset (§2), working live deposit rate fetch with caching (§3), multi-language support for en/ru/zh/ar (§4), a generated app logo (§5), and hiding the Lovable badge via CSS (§6).
